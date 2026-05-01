/* =========================================
   ProctorAI — Proctor Dashboard Logic
   ========================================= */

let user = null;
let generatedQuestions = [];

/* ---- Init ---- */
function init() {
  user = requireAuth('proctor', 'student.html');
  setNavUser(user);

  const firstName = user.name.split(' ').slice(-1)[0];
  document.getElementById('welcome-title').textContent = `Welcome, ${firstName} 👋`;

  loadData();
}

/* ---- Load all data ---- */
async function loadData() {
  await Promise.all([loadTests(), loadStudents()]);
}

/* ==============================
   TESTS
   ============================== */

async function loadTests() {
  try {
    const { ok, data } = await apiFetch('/api/tests');
    if (!ok) throw new Error();

    document.getElementById('stat-tests').textContent = data.length;
    renderTestsTable(data, 'overview-tests-table');
    renderTestsTable(data, 'tests-table');
  } catch (e) {
    const err = '<div style="color:var(--text3);font-size:13px;padding:24px;">Could not load tests — is Flask running on port 5000?</div>';
    document.getElementById('overview-tests-table').innerHTML = err;
    document.getElementById('tests-table').innerHTML          = err;
  }
}

function renderTestsTable(tests, id) {
  const el = document.getElementById(id);

  if (!tests.length) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="icon">📝</div>
        <p>No tests created yet.<br>Click "New Test" to get started.</p>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="table-header">
      <span class="table-title">${tests.length} test${tests.length !== 1 ? 's' : ''}</span>
    </div>
    <table>
      <thead><tr>
        <th>Title</th>
        <th>Subject</th>
        <th>Duration</th>
        <th>Marks</th>
        <th>Scheduled</th>
        <th>Status</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${tests.map(t => `
          <tr>
            <td style="font-weight:500">${t.title}</td>
            <td><span class="badge badge-purple">${t.subject || '—'}</span></td>
            <td>${t.duration || '—'} min</td>
            <td>${t.totalMarks || '—'}</td>
            <td style="color:var(--text2);font-size:13px">
              ${t.scheduledAt ? new Date(t.scheduledAt).toLocaleDateString() : '—'}
            </td>
            <td><span class="badge badge-green"><span class="badge-dot"></span> Active</span></td>
            <td><button class="action-btn danger" onclick="deleteTest('${t.id}')">Delete</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

async function deleteTest(id) {
  if (!confirm('Are you sure you want to delete this test?')) return;

  try {
    const { ok, data } = await apiFetch(`/api/tests/${id}`, { method: 'DELETE' });
    if (ok) {
      loadTests();
    } else {
      alert(data?.error || 'Failed to delete test');
    }
  } catch (e) {
    alert('Cannot reach server to delete test.');
  }
}

/* ==============================
   STUDENTS
   ============================== */

async function loadStudents() {
  try {
    const { ok, data } = await apiFetch('/api/users');
    if (!ok) throw new Error();

    document.getElementById('stat-students').textContent = data.length;
    renderStudentsTable(data);
  } catch (e) {
    document.getElementById('students-table').innerHTML =
      '<div style="color:var(--text3);font-size:13px;padding:24px;">Could not load students.</div>';
  }
}

function renderStudentsTable(students) {
  const el = document.getElementById('students-table');

  if (!students.length) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="icon">👥</div>
        <p>No students registered yet.</p>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="table-header">
      <span class="table-title">${students.length} student${students.length !== 1 ? 's' : ''}</span>
    </div>
    <table>
      <thead><tr>
        <th>Name</th>
        <th>Email</th>
        <th>Status</th>
        <th>Violations</th>
      </tr></thead>
      <tbody>
        ${students.map(s => `
          <tr>
            <td>
              <div class="student-name-cell">
                <div class="student-avatar">${getInitials(s.name)}</div>
                <span style="font-weight:500">${s.name}</span>
              </div>
            </td>
            <td style="color:var(--text2);font-size:13px">${s.email}</td>
            <td><span class="badge badge-green"><span class="badge-dot"></span> Registered</span></td>
            <td><span style="color:var(--text3);font-size:13px">—</span></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

/* ==============================
   AI QUESTION GENERATOR
   ============================== */

async function generateQuestions() {
  const topic = document.getElementById('ai-topic').value.trim()
              || document.getElementById('t-subject').value.trim()
              || 'General Knowledge';
  const count = parseInt(document.getElementById('ai-count').value);
  const diff  = document.getElementById('ai-diff').value;

  const btn = document.getElementById('gen-btn');
  btn.innerHTML = '<span class="gen-spinner"></span> Generating…';
  btn.disabled  = true;

  document.getElementById('q-preview').innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:16px 0;color:var(--text2);font-size:13px;">
      <div class="loading-spinner" style="border-color:rgba(124,107,255,0.3);border-top-color:var(--accent);width:20px;height:20px;border-width:2px;"></div>
      Calling GPT-4o-mini for ${count} ${diff.toLowerCase()} questions on "${topic}"…
    </div>`;

  try {
    const { ok, data } = await apiFetch('/api/questions', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: `Generate exactly ${count} ${diff} multiple choice questions about "${topic}".
Return ONLY valid JSON array, no markdown, no explanation:
[{"question":"...","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A"}]`
        }]
      })
    });

    const text = data.choices?.[0]?.message?.content || '';
    generatedQuestions = parseQuestions(text);
    renderQPreview(generatedQuestions);
  } catch (e) {
    document.getElementById('q-preview').innerHTML = `
      <div style="color:var(--red);font-size:13px;padding:12px 0;">
        Could not generate questions. Check your OpenRouter API key or Flask server.
      </div>`;
    generatedQuestions = [];
  }

  btn.innerHTML = 'Generate ✦';
  btn.disabled  = false;
}

function renderQPreview(qs) {
  document.getElementById('q-preview').innerHTML = `
    <div style="margin-top:16px;">
      <div class="gen-success">✓ ${qs.length} questions generated</div>
      <div class="q-list">
        ${qs.map((q, i) => `
          <div class="q-item">
            <div class="q-item-num">Q${i + 1}</div>
            <div class="q-item-text">${q.question}</div>
            <div class="q-item-options">
              ${q.options.map(o => `
                <span class="q-opt ${o.startsWith(q.answer) ? 'correct' : ''}">${o}</span>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    </div>`;
}

/* ==============================
   CREATE TEST
   ============================== */

async function createTest() {
  const title = document.getElementById('t-title').value.trim();

  if (!title) {
    showAlert('create-error', 'Please enter a test title.');
    return;
  }

  hideAlert('create-success');
  hideAlert('create-error');
  setLoading('create-btn', true, 'Save test', 'Saving…');

  try {
    const { ok, data } = await apiFetch('/api/tests', {
      method: 'POST',
      body: JSON.stringify({
        title,
        subject:     document.getElementById('t-subject').value,
        description: document.getElementById('t-desc').value,
        duration:    parseInt(document.getElementById('t-duration').value),
        totalMarks:  parseInt(document.getElementById('t-marks').value),
        scheduledAt: document.getElementById('t-scheduled').value,
        createdBy:   user.id
      })
    });

    if (ok) {
      showAlert('create-success', '✓ Test created successfully!');
      resetForm();
      loadTests();
      setTimeout(() => showView('tests'), 1200);
    } else {
      showAlert('create-error', data.error || 'Failed to create test.');
    }
  } catch (e) {
    showAlert('create-error', 'Cannot reach server.');
  }

  setLoading('create-btn', false, 'Save test');
}

function resetForm() {
  document.getElementById('t-title').value     = '';
  document.getElementById('t-subject').value   = '';
  document.getElementById('t-desc').value      = '';
  document.getElementById('t-scheduled').value = '';
  document.getElementById('t-duration').value  = '45';
  document.getElementById('t-marks').value     = '50';
  document.getElementById('ai-topic').value    = '';
  document.getElementById('q-preview').innerHTML = '';
  generatedQuestions = [];
}

/* ---- Boot ---- */
init();
