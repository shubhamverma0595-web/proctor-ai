/* =========================================
   ProctorAI — Shared Config & Auth Utilities
   ========================================= */

const API = '';

/**
 * Get the logged-in user from localStorage.
 * Returns null if not found.
 */
function getUser() {
  const stored = localStorage.getItem('user');
  return stored ? JSON.parse(stored) : null;
}

/**
 * Logout: clear storage and redirect to login.
 */
function logout() {
  localStorage.removeItem('user');
  window.location.href = 'login.html';
}

/**
 * Redirect if user is not logged in or wrong role.
 * @param {string} expectedRole - 'student' | 'proctor'
 * @param {string} redirectTo   - page to redirect to if wrong role
 */
function requireAuth(expectedRole, redirectTo) {
  const user = getUser();
  if (!user) return window.location.href = 'login.html';
  if (user.role !== expectedRole) return window.location.href = redirectTo;
  return user;
}

/**
 * Get user initials (up to 2 characters).
 */
function getInitials(name) {
  return name
    .split(' ')
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

/**
 * Set the nav user display.
 */
function setNavUser(user) {
  const initialsEl = document.getElementById('user-initials');
  const nameEl     = document.getElementById('user-name-nav');
  if (initialsEl) initialsEl.textContent = getInitials(user.name);
  if (nameEl)     nameEl.textContent     = user.name;
}

/**
 * Switch between named views. Matches sidebar nav buttons by id=nav-{name}.
 */
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.sidebar-item').forEach(b => b.classList.remove('active'));

  const view = document.getElementById(`view-${name}`);
  const nav  = document.getElementById(`nav-${name}`);
  if (view) view.classList.add('active');
  if (nav)  nav.classList.add('active');
}

/**
 * Show/hide an element by id.
 */
function show(id) { const el = document.getElementById(id); if (el) el.style.display = 'block'; }
function hide(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }

/**
 * Set a loading state on a button.
 */
function setLoading(btnId, loading, originalText, loadingText = 'Loading…') {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? loadingText : originalText;
}

/**
 * Show an alert element.
 */
function showAlert(id, message) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
}

function hideAlert(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

/**
 * Fetch wrapper with JSON body.
 */
async function apiFetch(path, options = {}) {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.error(`apiFetch failed for ${path}:`, err);
    return { ok: false, status: 500, data: { error: err.message } };
  }
}

/**
 * Fallback MCQ questions if AI endpoint fails.
 */
function getFallbackQuestions(topic, count) {
  return Array.from({ length: count }, (_, i) => ({
    question: `Sample question ${i + 1} about ${topic}: Which of the following is correct?`,
    options: ['A) Option one', 'B) Option two', 'C) Option three', 'D) Option four'],
    answer: 'A'
  }));
}

/**
 * Parse AI question JSON from raw LLM response text.
 */
function parseQuestions(rawText) {
  const clean = rawText.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}
/**
 * Stylish Toast Notification
 */
function showToast(type, title, msg, duration = 4000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const icons = { success: '✓', error: '✕', warning: '⚠' };
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || 'i'}</div>
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      <div class="toast-msg">${msg}</div>
    </div>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/**
 * Stylish Notice Modal (replaces alert)
 */
function showNotice(title, msg, icon = 'ℹ️') {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'notice-overlay';
    overlay.innerHTML = `
      <div class="notice-card">
        <div class="notice-icon">${icon}</div>
        <div class="notice-title">${title}</div>
        <div class="notice-msg">${msg}</div>
        <button class="notice-btn">Acknowledge</button>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('.notice-btn').onclick = () => {
      overlay.style.opacity = '0';
      setTimeout(() => {
        overlay.remove();
        resolve();
      }, 300);
    };
  });
}
