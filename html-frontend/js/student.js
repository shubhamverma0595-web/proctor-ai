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
let lastCapturedFrame = null;
let lastFrameSent = 0;
let frameInterval = null;
let heartbeatInterval = null;

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
        if (res.ok && res.data.warning) {
            showProctorWarning(res.data.warning);
        }
        if (!res.ok) console.error("Server sync failed:", res.data);
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
  if (!user) return; // Should be handled by requireAuth, but just in case

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  
  const userNameEl = document.getElementById('user-name');
  if (userNameEl) userNameEl.textContent = user.name || 'Student';

  const welcomeTitleEl = document.getElementById('welcome-title');
  if (welcomeTitleEl) {
    const firstName = (user.name || 'Student').split(' ')[0];
    welcomeTitleEl.textContent = `${greeting}, ${firstName} 👋`;
  }

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
  if (!canvas) return;
  
  if (!results.length) {
    const emptyEl = document.getElementById('chart-empty');
    if (emptyEl) emptyEl.style.display = 'flex';
    canvas.style.display = 'none';
    return;
  } else {
    const emptyEl = document.getElementById('chart-empty');
    if (emptyEl) emptyEl.style.display = 'none';
    canvas.style.display = 'block';
  }

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width  = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  
  const W = rect.width;
  const H = rect.height;
  ctx.clearRect(0, 0, W, H);

  const padT   = 24;
  const padB   = 24;
  const padX   = 16;
  const innerW = W - padX * 2;
  const innerH = H - padT - padB;
  
  // Draw horizontal grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  [0, 0.25, 0.5, 0.75, 1].forEach(tick => {
    const y = padT + innerH * (1 - tick);
    ctx.beginPath();
    ctx.moveTo(padX, y);
    ctx.lineTo(W - padX, y);
    ctx.stroke();
  });

  const barGap = 12;
  const barW   = Math.min(36, (innerW - (results.length - 1) * barGap) / results.length);
  const totalBarSpace = results.length * barW + (results.length - 1) * barGap;
  const startX = padX + (innerW - totalBarSpace) / 2;

  results.forEach((r, i) => {
    const x    = startX + i * (barW + barGap);
    const val  = r.pct || 0;
    const barH = Math.max(6, (val / 100) * innerH);
    const y    = padT + innerH - barH;

    const colorMain = val >= 70 ? '#34d399' : val >= 50 ? '#fbbf24' : '#f87171';
    const colorDark = val >= 70 ? '#059669' : val >= 50 ? '#d97706' : '#dc2626';

    // Gradient bar
    const grad = ctx.createLinearGradient(x, y, x, y + barH);
    grad.addColorStop(0, colorMain);
    grad.addColorStop(1, colorDark);

    // Glow / Shadow
    ctx.shadowBlur = 10;
    ctx.shadowColor = colorMain + '44';
    
    // Bar shape
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(x, y, barW, barH, [6, 6, 2, 2]);
    } else {
      ctx.rect(x, y, barW, barH);
    }
    ctx.fillStyle = grad;
    ctx.fill();
    
    ctx.shadowBlur = 0; // reset shadow

    // Score label
    ctx.fillStyle = val >= 70 ? '#6ee7b7' : val >= 50 ? '#fcd34d' : '#fca5a5';
    ctx.font = `600 11px var(--font-display), system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText(`${val}%`, x + barW / 2, y - 8);

    // Subject label (truncated)
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = `500 9px var(--font-body), system-ui`;
    let sub = (r.subject || 'Exam');
    if (sub.length > 8) sub = sub.slice(0, 7) + '..';
    ctx.fillText(sub, x + barW / 2, H - 8);
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
  const date   = new Date(r.date).toLocaleDateString('en-IN', { day:'numeric', month:'short' });
  const year   = new Date(r.date).getFullYear();
  const time   = new Date(r.date).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });

  const breakdown = (r.breakdown || []).map((b, qi) => {
    const isCorrect = b.selected === b.correct;
    return `
    <div class="bd-row ${isCorrect ? 'bd-correct' : 'bd-wrong'}">
      <div class="bd-num">Q${qi+1}</div>
      <div class="bd-q">${b.question || ''}</div>
      <div class="bd-ans">
        ${isCorrect ? '<span class="tick">✓</span>' : `<span class="cross">✕</span> <small>(${b.correct})</small>`}
      </div>
    </div>`;
  }).join('');

  return `
  <div class="result-card" id="rc-${i}">
    <div class="result-card-header" onclick="toggleResultDetail(${i})">
      <div class="rc-left">
        <div class="grade-badge" style="--gc:${gradeColor}">
          <span class="grade-text">${grade}</span>
        </div>
        <div class="rc-info">
          <div class="rc-title">${r.title || 'Exam'}</div>
          <div class="rc-meta">
            <span class="rc-tag">${r.subject || 'General'}</span>
            <span class="rc-dot"></span>
            <span>${date}, ${year}</span>
            <span class="rc-dot"></span>
            <span>${time}</span>
          </div>
        </div>
      </div>
      <div class="rc-right">
        <div class="rc-score-wrap">
          <div class="rc-score">${r.pct}%</div>
          <div class="rc-fraction">${r.score}/${r.total} <span style="opacity:0.6">correct</span></div>
        </div>
        <span class="rc-chevron" id="chev-${i}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
        </span>
      </div>
    </div>

    <!-- Progress bar track -->
    <div class="rc-progress-wrap">
      <div class="rc-progress-bar" style="width:${r.pct}%; background: linear-gradient(90deg, ${gradeColor}, ${gradeColor}aa)"></div>
    </div>

    <!-- Detail breakdown -->
    <div class="rc-detail" id="detail-${i}" style="display:none;">
      <div class="detail-inner">
        <div class="detail-stats">
          <div class="d-stat">
            <label>Time Taken</label>
            <value>⏱ ${formatTime(r.timeTaken || 0)}</value>
          </div>
          <div class="d-stat">
            <label>Violations</label>
            <value class="${r.violations > 0 ? 'red' : ''}">${r.violations > 0 ? `⚠ ${r.violations}` : '✓ None'}</value>
          </div>
          <div class="d-stat">
            <label>Accuracy</label>
            <value>${r.pct}%</value>
          </div>
        </div>
        
        <div class="breakdown-title">Question Breakdown</div>
        <div class="bd-list">${breakdown || '<div style="padding:16px;color:var(--text3);text-align:center;">No breakdown available</div>'}</div>
        
        <div class="detail-actions">
          <button class="btn-retake" onclick="retakeExam('${r.testId}','${r.subject}')">
            <span>Retake Exam</span>
          </button>
          <button class="btn-delete" onclick="deleteResult(${i})">
            <span>Delete</span>
          </button>
        </div>
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
  setupActivityMonitoring();
}

function setupActivityMonitoring() {
  // Detect Tab Switching / Browser Minimizing
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && currentTest) {
      violationCount++;
      const msg = "Tab switch / Browser minimized!";
      console.warn(msg);
      broadcastSession({ 
        faceStatus: 'err', 
        faceMessage: msg,
        violations: violationCount
      });
      showNotice("⚠️ ACTIVITY WARNING", "You switched tabs or minimized the browser! This activity has been reported to the proctor.", "🚫");
    }
  });

  // Detect Fullscreen Exit
  window.addEventListener('resize', () => {
    if (currentTest && !document.fullscreenElement && !window.innerHeight >= screen.height - 10) {
      // Small delay to avoid triggering on slight resizes
      setTimeout(() => {
        if (!document.fullscreenElement) {
           console.warn("Fullscreen exited");
           // We can log this but not necessarily count as violation unless required
        }
      }, 1000);
    }
  });
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
let analyzeCanvas = null; // reuse canvas across ticks

function startMonitoring() {
  analyzeCanvas = document.createElement('canvas');

  // ── FRAME BROADCAST: every 500ms → ~2fps smooth live view ──────────
  const frameCanvas = document.createElement('canvas');
  frameCanvas.width  = 320;   // higher res for cleaner display
  frameCanvas.height = 240;
  const frameCtx = frameCanvas.getContext('2d');
  lastFrameSent = 0;

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
          console.error("Analysis service error:", data);
          // Show error in the log so the user knows why it's not working
          const log = document.getElementById('violation-log');
          if (log) {
            log.innerHTML = `<div class="violation-item" style="background:rgba(255,255,255,0.05);color:var(--text3);border-color:var(--border)">
              ⚠️ AI Analysis Service Unavailable
            </div>`;
          }
      }
    } catch(err) { 
      console.error("Analysis communication error:", err); 
    }
  }, 6000);  // every 6 seconds
}

function updateViolationLog(data) {
  const log = document.getElementById('violation-log');
  if (!log) return;
  
  if (data.violations && data.violations.length > 0) {
    violationCount += data.violations.length;
    log.innerHTML = data.violations.map(v => {
      const label = v === 'face_not_visible' ? 'Face not visible' : 
                    v === 'multiple_faces' ? 'Multiple faces detected' : 
                    v.replace(/_/g, ' ');
      return `<div class="violation-item">⚠ ${label}</div>`;
    }).join('');
    
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
          <div class="bd-stat">
            <span class="bd-stat-val green">${score}</span>
            <span class="bd-stat-label">Correct</span>
          </div>
          <div class="bd-stat">
            <span class="bd-stat-val red">${total - score}</span>
            <span class="bd-stat-label">Wrong</span>
          </div>
          <div class="bd-stat">
            <span class="bd-stat-val amber">${total - Object.keys(answers).length}</span>
            <span class="bd-stat-label">Skipped</span>
          </div>
          <div class="bd-stat">
            <span class="bd-stat-val">${formatTime(timeTaken)}</span>
            <span class="bd-stat-label">Time taken</span>
          </div>
        </div>
        <div class="breakdown-q-list">
          ${breakdown.map((b, i) => `
            <div class="bq-row ${b.selected === b.correct ? 'bq-correct' : 'bq-wrong'}">
              <div class="bq-icon">
                ${b.selected === b.correct 
                  ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' 
                  : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'}
              </div>
              <div class="bq-body">
                <div class="bq-q">Q${i+1}: ${b.question}</div>
                <div class="bq-ans">
                  ${b.selected ? `Selected: <strong>${b.selected}</strong>` : `<span style="opacity:0.5">Not answered</span>`}
                  ${b.selected !== b.correct ? ` &nbsp;•&nbsp; Correct: <strong style="color:var(--green)">${b.correct}</strong>` : ''}
                </div>
              </div>
            </div>
          `).join('')}
        </div>`;
    }
  } catch (err) {
    console.error("Critical error during submission:", err);
    showNotice("⚠️ SUBMISSION ERROR", "There was an error saving your results locally, but your camera has been stopped. Please contact your instructor if you see this message.", "❌");
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

/* ==============================
   PROCTOR WARNINGS
   ============================== */

function showProctorWarning(msg) {
  showNotice("PROCTOR MESSAGE", msg, "⚠️").then(() => {
    // Notify server that warning was seen
    apiFetch('/api/proctor/clear_warning', {
        method: 'POST',
        body: JSON.stringify({ studentId: user?.id })
    });
  });
}

/* ---- Boot ---- */
init();
