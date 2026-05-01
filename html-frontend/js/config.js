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
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
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
