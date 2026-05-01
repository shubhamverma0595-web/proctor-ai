/* =========================================
   ProctorAI — Student Portal Logic
   v2.0 — with persistent results storage
   ========================================= */

let user = null;
let questions = [];
let currentQ = 0;
let answers = {};
let timerInterval = null;
let monitorInterval = null;
let webcamStream = null;
let currentTest = null;
let timeLeft = 0;
let examStartTime = null;
let violationCount = 0;
let lastCapturedFrame = null; // Global to store the latest frame for server sync

/* ==============================
   LIVE SESSION BROADCAST
   Writes real-time exam state to localStorage so the
   proctor monitor page can read it across browser tabs.
   Same origin (localhost:5000) = shared localStorage.
   ============================== */

const SESSION_PREFIX = 'proctor_live_session_';

function sessionKey() {
  return `${SESSION_PREFIX}${user?.id || 'guest'}`;
}

function broadcastSession(extra = {}) {
  if (!currentTest) return;
  const session = {
    studentId:     user?.id,
    name:          user?.name,
    email:         user?.email,
    examTitle:     currentTest?.title  || 'Exam',
    subject:       currentTest?.subject || 'General',
    status:        'active',
    progress:      questions.length ? Math.round((Object.keys(answers).length / questions.length) * 100) : 0,
    answered:      Object.keys(answers).length,
    total:         questions.length || 0,
    currentQ:      currentQ + 1,
    violations:    violationCount,
    faceStatus:    'ok',
    faceMessage:   'Face detected',
    timeLeft:      timeLeft,
    startedAt:     examStartTime ? new Date(examStartTime).toISOString() : new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    ...extra
  };
  try { localStorage.setItem(sessionKey(), JSON.stringify(session)); } catch(e) {}

  // --- SERVER SYNC (for remote proctoring) ---
  const serverData = { ...session };
  if (lastCapturedFrame) serverData.lastFrame = lastCapturedFrame;
  
  try {
    console.log("Broadcasting session to server:", serverData.studentId);
    apiFetch('/api/proctor/update', {
      method: 'POST',
      body: JSON.stringify(serverData)
    }).then(res => {
        if (!res.ok) console.error("Server sync failed:", res.data);
        else console.log("Server sync successful");
    });
  } catch(e) {
    console.error("Broadcast error:", e);
  }
}

function clearSession(completed = true) {
  try {
    const key  = sessionKey();
    const prev = JSON.parse(localStorage.getItem(key) || '{}');
    localStorage.setItem(key, JSON.stringify({
      ...prev,
      status:        completed ? 'completed' : 'exited',
      lastHeartbeat: new Date().toISOString()
    }));

    // Update server status too
    try {
      apiFetch('/api/proctor/update', {
        method: 'POST',
        body: JSON.stringify({
          studentId: user?.id,
          status: completed ? 'completed' : 'exited'
        })
      });
    } catch(e) {}

    // Remove session + frame after 6 seconds
    setTimeout(() => {
      localStorage.removeItem(key);
      localStorage.removeItem('proctor_frame_' + (user && user.id || 'guest'));
    }, 6000);
  } catch(e) {}
}


/* ==============================
   RESULTS STORAGE (localStorage)
   ============================== */

function resultsKey() {
  return `proctor_results_${user?.id || 'guest'}`;
}

function saveResult(result) {
  const all = loadResults();
  all.unshift(result);          // newest first
  localStorage.setItem(resultsKey(), JSON.stringify(all.slice(0, 50))); // keep last 50
}

function loadResults() {
  try {
    return JSON.parse(localStorage.getItem(resultsKey()) || '[]');
  } catch { return []; }
}

function computeStats() {
  const results = loadResults();
  if (!results.length) return { completed: 0, avgScore: 0, bestScore: 0, totalTime: 0, streak: 0 };

  const scores   = results.map(r => r.pct);
  const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const bestScore = Math.max(...scores);
  const totalTime = results.reduce((a, r) => a + (r.timeTaken || 0), 0);

  // streak: consecutive days with at least one result
  let streak = 0;
  const today = new Date(); today.setHours(0,0,0,0);
  const days  = new Set(results.map(r => {
    const d = new Date(r.date); d.setHours(0,0,0,0); return d.getTime();
  }));
  for (let i = 0; i < 30; i++) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    if (days.has(d.getTime())) streak++;
    else if (i > 0) break;
  }

  return { completed: results.length, avgScore, bestScore, totalTime, streak };
}

/* ==============================
   INIT
   ============================== */

function init() {
  user = requireAuth('student', 'proctor.html');
  setNavUser(user);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  document.getElementById('welcome-title').textContent =
    `${greeting}, ${user.name.split(' ')[0]} 👋`;

  loadTests();
  refreshDashboardStats();

  // Check if we should jump to results tab (after reload)
  if (window.location.hash === '#results') {
    showStudentView('results');
  }
}

/* ==============================
   DASHBOARD STATS
   ============================== */

function refreshDashboardStats() {
  const s = computeStats();

  setEl('stat-completed',  s.completed);
  setEl('stat-avg',        s.completed ? `${s.avgScore}%` : '—');
  setEl('stat-best',       s.completed ? `${s.bestScore}%` : '—');
  setEl('stat-streak',     s.streak ? `${s.streak}d` : '0d');

  // Mini score chart
  renderMiniChart();
}

function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function renderMiniChart() {
  const results = loadResults().slice(0, 7).reverse(); // last 7, oldest→newest
  const canvas  = document.getElementById('score-chart');
  if (!canvas || !results.length) return;

  const ctx = canvas.getContext('2d');
  const W = canvas.width  = canvas.offsetWidth;
  const H = canvas.height = canvas.offsetHeight;
  ctx.clearRect(0, 0, W, H);

  const pad   = 24;
  const barW  = Math.min(32, (W - pad * 2) / results.length - 6);
  const maxH  = H - pad * 2;

  results.forEach((r, i) => {
    const x    = pad + i * ((W - pad * 2) / results.length) + ((W - pad * 2) / results.length - barW) / 2;
    const barH = Math.max(4, (r.pct / 100) * maxH);
    const y    = H - pad - barH;

    const color = r.pct >= 70 ? '#34d399' : r.pct >= 50 ? '#fbbf24' : '#f87171';

    // Bar
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, 4);
    ctx.fillStyle = color + '33';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Score label
    ctx.fillStyle = color;
    ctx.font = `bold 10px DM Sans, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`${r.pct}%`, x + barW / 2, y - 4);

    // Subject label
    ctx.fillStyle = '#5c5878';
    ctx.font = `9px DM Sans, sans-serif`;
    ctx.fillText((r.subject || 'Exam').slice(0, 6), x + barW / 2, H - 6);
  });
}

/* ==============================
   TESTS
   ============================== */

async function loadTests() {
  try {
    const { ok, data } = await apiFetch('/api/tests');
    if (!ok) throw new Error();
    setEl('stat-available', data.length);
    renderTests(data, 'dash-tests');
    renderTests(data, 'all-tests');
  } catch {
    const msg = `<div style="color:var(--text3);font-size:13px;padding:20px 0;text-align:center;">
      <div style="font-size:28px;margin-bottom:8px;">⚠️</div>
      Could not load tests — is the Flask server running on port 5000?
    </div>`;
    document.getElementById('dash-tests').innerHTML = msg;
    document.getElementById('all-tests').innerHTML  = msg;
  }
}

function renderTests(tests, containerId) {
  const container = document.getElementById(containerId);
  const results   = loadResults();

  if (!tests.length) {
    container.innerHTML = `<div style="color:var(--text3);font-size:14px;padding:20px 0;">No tests scheduled yet.</div>`;
    return;
  }

  container.innerHTML = tests.map(t => {
    const past = results.find(r => r.testId === t.id);
    const statusClass = past ? 'badge-completed' : 'badge-available';
    const statusLabel = past ? `✓ ${past.pct}%` : 'Available';
    const btnClass    = past ? 'retake' : '';
    const btnLabel    = past ? 'Retake →' : 'Start Exam →';

    return `
    <div class="test-card" onclick='openTest(${JSON.stringify(t).replace(/'/g,"&#39;")})'>
      <div class="test-card-header">
        <span class="test-subject">${t.subject || 'General'}</span>
        <span class="test-status-badge ${statusClass}">${statusLabel}</span>
      </div>
      <div class="test-title">${t.title}</div>
      <div class="test-desc">${t.description || 'No description provided.'}</div>
      <div class="test-meta">
        <div class="test-meta-item">⏱ ${t.duration || 45} min</div>
        <div class="test-meta-item">📊 ${t.totalMarks || 50} marks</div>
        ${past ? `<div class="test-meta-item" style="color:var(--green);">🏆 Best: ${past.pct}%</div>` : ''}
      </div>
      <button class="test-btn ${btnClass}">${btnLabel}</button>
    </div>`;
  }).join('');
}

/* ==============================
   RESULTS TAB
   ============================== */

function renderResultsTab() {
  const results  = loadResults();
  const container = document.getElementById('results-container');
  if (!container) return;

  if (!results.length) {
    container.innerHTML = `
      <div style="text-align:center;padding:60px 20px;color:var(--text3);">
        <div style="font-size:48px;margin-bottom:16px;">📋</div>
        <div style="font-family:var(--font-display);font-size:18px;color:var(--text2);margin-bottom:8px;">No exams completed yet</div>
        <div style="font-size:14px;">Take a test from the Dashboard to see your results here.</div>
      </div>`;
    return;
  }

  const stats = computeStats();

  container.innerHTML = `
    <!-- Summary stats -->
    <div class="results-stats-grid">
      <div class="rstat-card">
        <div class="rstat-label">Exams taken</div>
        <div class="rstat-value purple">${stats.completed}</div>
      </div>
      <div class="rstat-card">
        <div class="rstat-label">Average score</div>
        <div class="rstat-value ${stats.avgScore >= 70 ? 'green' : stats.avgScore >= 50 ? 'amber' : 'red'}">${stats.avgScore}%</div>
      </div>
      <div class="rstat-card">
        <div class="rstat-label">Best score</div>
        <div class="rstat-value green">${stats.bestScore}%</div>
      </div>
      <div class="rstat-card">
        <div class="rstat-label">Study streak</div>
        <div class="rstat-value amber">${stats.streak}d 🔥</div>
      </div>
      <div class="rstat-card">
        <div class="rstat-label">Total time</div>
        <div class="rstat-value">${formatTime(stats.totalTime)}</div>
      </div>
    </div>

    <!-- History list -->
    <div class="section-title" style="margin-top:24px;margin-bottom:12px;">Exam history</div>
    <div class="results-list">
      ${results.map((r, i) => renderResultCard(r, i)).join('')}
    </div>`;
}

function renderResultCard(r, i) {
  const grade  = r.pct >= 90 ? 'A+' : r.pct >= 80 ? 'A' : r.pct >= 70 ? 'B' :
                 r.pct >= 60 ? 'C'  : r.pct >= 50 ? 'D' : 'F';
  const gradeColor = r.pct >= 70 ? 'var(--green)' : r.pct >= 50 ? 'var(--amber)' : 'var(--red)';
  const date   = new Date(r.date).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
  const time   = new Date(r.date).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });

  const breakdown = (r.breakdown || []).map((b, qi) => {
    const isCorrect = b.selected === b.correct;
    return `<div class="bd-row ${isCorrect ? 'bd-correct' : 'bd-wrong'}">
      <span class="bd-num">Q${qi+1}</span>
      <span class="bd-q">${b.question || ''}</span>
      <span class="bd-ans">${isCorrect ? '✓' : `✗ (${b.correct})`}</span>
    </div>`;
  }).join('');

  return `
  <div class="result-card" id="rc-${i}">
    <div class="result-card-header" onclick="toggleResultDetail(${i})">
      <div class="rc-left">
        <div class="grade-ring" style="--gc:${gradeColor}">
          <span class="grade-letter" style="color:${gradeColor}">${grade}</span>
        </div>
        <div>
          <div class="rc-title">${r.title || 'Exam'}</div>
          <div class="rc-meta">
            <span>${r.subject || 'General'}</span>
            <span>•</span>
            <span>${date} at ${time}</span>
            <span>•</span>
            <span>⏱ ${formatTime(r.timeTaken || 0)}</span>
            ${r.violations > 0 ? `<span>• ⚠ ${r.violations} violation${r.violations>1?'s':''}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="rc-right">
        <div class="rc-score">${r.pct}%</div>
        <div class="rc-fraction">${r.score}/${r.total} correct</div>
        <span class="rc-chevron" id="chev-${i}">›</span>
      </div>
    </div>

    <!-- Progress bar -->
    <div class="rc-progress-wrap">
      <div class="rc-progress-bar" style="width:${r.pct}%;background:${gradeColor}"></div>
    </div>

    <!-- Detail breakdown -->
    <div class="rc-detail" id="detail-${i}" style="display:none;">
      ${breakdown ? `
        <div style="padding:14px 16px 4px;font-size:12px;font-weight:500;color:var(--text2);text-transform:uppercase;letter-spacing:0.05em;">Question breakdown</div>
        <div class="bd-list">${breakdown}</div>
      ` : '<div style="padding:16px;color:var(--text3);font-size:13px;">No question breakdown available.</div>'}
      <div style="padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px;">
        <button onclick="retakeExam('${r.testId}','${r.subject}')" style="padding:7px 16px;background:var(--accent);border:none;border-radius:8px;color:white;font-family:var(--font-display);font-size:12px;font-weight:600;cursor:pointer;">Retake exam</button>
        <button onclick="deleteResult(${i})" style="padding:7px 12px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--text3);font-family:var(--font-body);font-size:12px;cursor:pointer;">Delete record</button>
      </div>
    </div>
  </div>`;
}

function toggleResultDetail(i) {
  const detail = document.getElementById(`detail-${i}`);
  const chev   = document.getElementById(`chev-${i}`);
  const open   = detail.style.display === 'none';
  detail.style.display = open ? 'block' : 'none';
  if (chev) chev.style.transform = open ? 'rotate(90deg)' : 'none';
}

function deleteResult(i) {
  const all = loadResults();
  all.splice(i, 1);
  localStorage.setItem(resultsKey(), JSON.stringify(all));
  renderResultsTab();
  refreshDashboardStats();
}

function retakeExam(testId, subject) {
  const fakeTest = { id: testId, title: `Retake: ${subject}`, subject, duration: 45, totalMarks: 50 };
  openTest(fakeTest);
}

function formatTime(seconds) {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/* ==============================
   VIEW SWITCHING
   ============================== */

function showStudentView(name) {
  showView(name);
  if (name === 'results') renderResultsTab();
  if (name === 'dashboard') {
    refreshDashboardStats();
    setTimeout(renderMiniChart, 50);
  }
}

/* ==============================
   EXAM SESSION
   ============================== */

async function openTest(test) {
  currentTest   = test;
  violationCount = 0;
  examStartTime = Date.now();

  document.getElementById('exam-overlay').style.display = 'block';
  document.body.style.overflow = 'hidden';
  document.getElementById('exam-overlay-title').textContent = test.title;
  document.getElementById('active-exam-title').textContent  = test.title;
  document.getElementById('active-exam-sub').textContent    = test.subject || 'General';

  questions = []; answers = {}; currentQ = 0;
  console.log("Starting exam session for test:", test.id);
  broadcastSession({ status: 'active' }); 

  const examView = document.getElementById('exam-view');
  const resultView = document.getElementById('result-view');
  if (examView)   { examView.style.display = 'flex'; examView.classList.add('active'); }
  if (resultView) resultView.style.display = 'none';

  timeLeft = (test.duration || 45) * 60;
  updateTimerDisplay();

  await startWebcam();
  await generateQuestions(test.subject || 'General Knowledge', 10);
  startTimer();
}

function closeExam() {
  clearSession(false);
  stopWebcam();
  clearTimers();
  
  // Force a full page reload to ensure all stats and states are clean
  window.location.href = 'student.html';
}

function clearTimers() {
  if (timerInterval)     { clearInterval(timerInterval);     timerInterval     = null; }
  if (monitorInterval)   { clearInterval(monitorInterval);   monitorInterval   = null; }
  if (frameInterval)     { cancelAnimationFrame(frameInterval); frameInterval  = null; }
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

/* ---- Webcam ---- */
async function startWebcam() {
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({ video: true });
    const feed = document.getElementById('webcam-feed');
    if (feed) { feed.srcObject = webcamStream; feed.style.display = 'block'; }
    startMonitoring();
  } catch {
    const feed = document.getElementById('webcam-feed');
    if (feed) feed.style.display = 'none';
  }
}

function stopWebcam() {
  if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }
  // frameInterval is now a rAF id
  if (frameInterval) { cancelAnimationFrame(frameInterval); frameInterval = null; }
}

/* Two separate loops:
   1. frameInterval  — captures & shares webcam frame every 1 second (smooth live view)
   2. monitorInterval — sends frame to Flask /api/analyze every 6 seconds (face detection)
*/
let frameInterval = null;
let analyzeCanvas = null; // reuse canvas across ticks

function startMonitoring() {
  analyzeCanvas = document.createElement('canvas');

  // ── FRAME BROADCAST: every 500ms → ~2fps smooth live view ──────────
  const frameCanvas = document.createElement('canvas');
  frameCanvas.width  = 320;   // higher res for cleaner display
  frameCanvas.height = 240;
  const frameCtx = frameCanvas.getContext('2d');
  let lastFrameSent = 0;

  // Use requestAnimationFrame for smooth capture timing
  function captureAndBroadcast(ts) {
    if (ts - lastFrameSent >= 2000) {          // Sync with server every 2 seconds for live view
      const video = document.getElementById('webcam-feed');
      if (video && video.srcObject && video.readyState >= 2) {
        frameCtx.drawImage(video, 0, 0, 320, 240);
        try {
          const frameData = frameCanvas.toDataURL('image/jpeg', 0.60);
          lastCapturedFrame = frameData;
          
          // Local storage sync (instant for same-tab)
          localStorage.setItem(
            'proctor_frame_' + (user && user.id || 'guest'),
            JSON.stringify({ f: frameData, t: Date.now() })
          );

          // Server sync (remote proctoring)
          broadcastSession();

        } catch(e) { console.warn("Frame broadcast failed:", e); }
        lastFrameSent = ts;
      }
    }
    frameInterval = requestAnimationFrame(captureAndBroadcast);
  }
  frameInterval = requestAnimationFrame(captureAndBroadcast);

  // ── FACE ANALYSIS: every 6 seconds ───────────────────────────────
  analyzeCanvas.width  = 320;
  analyzeCanvas.height = 240;
  monitorInterval = setInterval(async () => {
    const video = document.getElementById('webcam-feed');
    if (!video || !video.srcObject) return;
    analyzeCanvas.getContext('2d').drawImage(video, 0, 0, 320, 240);
    try {
      console.log("Sending frame to analysis API...");
      const { ok, data } = await apiFetch('/api/analyze', {
        method: 'POST',
        body: JSON.stringify({ image: analyzeCanvas.toDataURL('image/jpeg', 0.7) })
      });
      if (ok) {
          console.log("Analysis successful:", data);
          updateViolationLog(data);
      } else {
          console.error("Analysis failed:", data);
      }
    } catch(err) { console.error("Analysis error:", err); }
  }, 6000);  // every 6 seconds
}

function updateViolationLog(data) {
  const log = document.getElementById('violation-log');
  if (!log) return;
  if (data.violations?.length) {
    violationCount += data.violations.length;
    log.innerHTML = data.violations.map(v => `
      <div class="violation-item">⚠ ${v === 'face_not_visible' ? 'Face not visible' : 'Multiple faces detected'}</div>
    `).join('');
    const msg = data.violations[0] === 'face_not_visible' ? 'Face not visible' : 'Multiple faces detected';
    broadcastSession({ faceStatus: 'err', faceMessage: msg });
  } else {
    log.innerHTML = '<div class="ok-status">✓ Face detected — all clear</div>';
    broadcastSession({ faceStatus: 'ok', faceMessage: 'Face detected' });
  }
}

/* ---- Question generation ---- */
async function generateQuestions(topic, count) {
  document.getElementById('question-area').innerHTML = `
    <div class="loading-state">
      <div class="loading-spinner"></div>
      <div class="loading-text">Generating ${count} questions on "${topic}"…</div>
    </div>`;

  try {
    const { ok, data } = await apiFetch('/api/questions', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: `Generate exactly ${count} multiple choice questions about "${topic}".
Return ONLY valid JSON array, no markdown, no explanation:
[{"question":"...","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A"}]`
        }]
      })
    });
    const text = data.choices?.[0]?.message?.content || '';
    questions = parseQuestions(text);
  } catch {
    questions = getFallbackQuestions(topic, count);
  }

  answers = {}; currentQ = 0;
  renderQuestion();
  renderQGrid();
}

/* ---- Render question ---- */
function renderQuestion() {
  if (!questions.length) return;
  const q    = questions[currentQ];
  const keys = ['A','B','C','D'];

  document.getElementById('question-area').innerHTML = `
    <div class="question-card">
      <div class="q-number">Question ${currentQ + 1} of ${questions.length}</div>
      <div class="q-text">${q.question}</div>
      <div class="options">
        ${q.options.map((opt, i) => `
          <button class="option-btn ${answers[currentQ] === keys[i] ? 'selected' : ''}"
                  onclick="selectAnswer('${keys[i]}')">
            <span class="option-key">${keys[i]}</span>
            ${opt.replace(/^[A-D]\)\s*/,'')}
          </button>
        `).join('')}
      </div>
    </div>
    <div class="exam-nav">
      <button class="nav-btn prev" onclick="prevQ()" ${currentQ === 0 ? 'disabled' : ''}>← Previous</button>
      ${currentQ < questions.length - 1
        ? `<button class="nav-btn next" onclick="nextQ()">Next →</button>`
        : `<button class="nav-btn submit" onclick="submitExam()">Submit exam ✓</button>`
      }
    </div>`;

  renderQGrid();
}

function selectAnswer(key) { answers[currentQ] = key; renderQuestion(); broadcastSession(); }
function nextQ() { if (currentQ < questions.length - 1) { currentQ++; renderQuestion(); } }
function prevQ() { if (currentQ > 0) { currentQ--; renderQuestion(); } }

function renderQGrid() {
  const grid = document.getElementById('q-grid');
  if (!grid) return;
  grid.innerHTML = questions.map((_, i) => `
    <div class="q-dot ${i === currentQ ? 'current' : answers[i] ? 'answered' : ''}"
         onclick="goToQ(${i})">${i+1}</div>
  `).join('');
}

function goToQ(i) { currentQ = i; renderQuestion(); }

/* ---- Submit & SAVE ---- */
function submitExam() {
  try {
    console.log("Submitting exam...");
    stopWebcam();
    clearTimers();

    // Score calculation
    let score = 0;
    const breakdown = questions.map((q, i) => {
      const qText   = q.question || 'Question';
      const correct = (q.answer || '').replace(/[^A-D]/g,'');
      const selected = answers[i] || null;
      if (selected === correct) score++;
      return { question: qText.slice(0,80), selected, correct };
    });

    const total     = questions.length;
    const pct       = total > 0 ? Math.round((score / total) * 100) : 0;
    const timeTaken = Math.round((Date.now() - (examStartTime || Date.now())) / 1000);

    // ✅ SAVE to localStorage
    const result = {
      id:         `r_${Date.now()}`,
      testId:     currentTest?.id || 'practice',
      title:      currentTest?.title || 'Exam',
      subject:    currentTest?.subject || 'General',
      score,
      total,
      pct,
      timeTaken,
      violations: violationCount,
      breakdown,
      date:       new Date().toISOString()
    };
    saveResult(result);
    clearSession(true);

    // Show result screen
    const examView   = document.getElementById('exam-view');
    const resultView = document.getElementById('result-view');
    if (examView)   { examView.style.display = 'none'; examView.classList.remove('active'); }
    if (resultView) resultView.style.display = 'block';

    // Populate result view
    const scoreDisplay = document.getElementById('score-display');
    if (scoreDisplay) scoreDisplay.textContent = `${pct}%`;
    
    const scoreRing = document.getElementById('score-ring');
    if (scoreRing) scoreRing.style.setProperty('--pct', `${pct * 3.6}deg`);
    
    const resultTitle = document.getElementById('result-title');
    if (resultTitle) {
        resultTitle.textContent  = pct >= 90 ? '🏆 Outstanding!' : pct >= 70 ? '🎉 Great job!' : pct >= 50 ? '👍 Good effort!' : '📚 Keep practicing!';
    }
    
    const resultSub = document.getElementById('result-sub');
    if (resultSub) {
        resultSub.textContent = `You scored ${score} out of ${total} questions`;
    }

    // Breakdown table
    const breakEl = document.getElementById('result-breakdown');
    if (breakEl) {
      breakEl.innerHTML = `
        <div class="breakdown-grid">
          <div class="bd-stat"><span class="bd-stat-val green">${score}</span><span class="bd-stat-label">Correct</span></div>
          <div class="bd-stat"><span class="bd-stat-val red">${total - score}</span><span class="bd-stat-label">Wrong</span></div>
          <div class="bd-stat"><span class="bd-stat-val amber">${Object.keys(answers).length < total ? total - Object.keys(answers).length : 0}</span><span class="bd-stat-label">Skipped</span></div>
          <div class="bd-stat"><span class="bd-stat-val">${formatTime(timeTaken)}</span><span class="bd-stat-label">Time taken</span></div>
        </div>
        <div class="breakdown-q-list">
          ${breakdown.map((b, i) => `
            <div class="bq-row ${b.selected === b.correct ? 'bq-correct' : 'bq-wrong'}">
              <div class="bq-icon">${b.selected === b.correct ? '✓' : '✗'}</div>
              <div class="bq-body">
                <div class="bq-q">Q${i+1}: ${b.question}</div>
                <div class="bq-ans">
                  ${b.selected ? `Your answer: <strong>${b.selected}</strong> &nbsp;` : `<span style="color:var(--text3)">Skipped</span> &nbsp;`}
                  ${b.selected !== b.correct ? `Correct: <strong style="color:var(--green)">${b.correct}</strong>` : ''}
                </div>
              </div>
            </div>
          `).join('')}
        </div>`;
    }
  } catch (err) {
    console.error("Critical error during submission:", err);
    alert("There was an error saving your results. Your camera has been stopped, but you can try refreshing the page.");
  }
}

/* ---- Timer ---- */
function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  let _heartbeatTick = 0;
  timerInterval = setInterval(() => {
    timeLeft--;
    updateTimerDisplay();
    if (++_heartbeatTick % 10 === 0) broadcastSession();
    if (timeLeft <= 0) { clearInterval(timerInterval); submitExam(); }
  }, 1000);
}

function updateTimerDisplay() {
  const m  = Math.floor(timeLeft / 60);
  const s  = timeLeft % 60;
  const el = document.getElementById('timer-display');
  if (!el) return;
  el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  el.className   = 'timer-value' + (timeLeft < 300 ? ' danger' : timeLeft < 600 ? ' warning' : '');
}

/* ==============================
   AI PRACTICE MODAL
   ============================== */

function openPractice()  { document.getElementById('practice-modal').classList.add('open'); }
function closePractice() { document.getElementById('practice-modal').classList.remove('open'); }

async function startPractice() {
  const topic = document.getElementById('prac-topic').value.trim() || 'General Knowledge';
  const count = parseInt(document.getElementById('prac-count').value);
  closePractice();
  const fakeTest = { id: `practice_${Date.now()}`, title: `Practice: ${topic}`, subject: topic, duration: 30, totalMarks: count * 5 };
  await openTest(fakeTest);
  await generateQuestions(topic, count);
}

/* ---- Boot ---- */
init();
