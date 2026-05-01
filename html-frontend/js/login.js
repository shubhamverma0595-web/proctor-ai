/* =========================================
   ProctorAI — Login Page Logic
   ========================================= */

let currentRole = 'student';

/* ---- Role toggle ---- */
function setRole(role) {
  currentRole = role;
  document.getElementById('btn-student').classList.toggle('active', role === 'student');
  document.getElementById('btn-proctor').classList.toggle('active', role === 'proctor');
  clearMessages();
}

/* ---- Switch between login / register ---- */
function showRegister() {
  hide('login-form');
  show('register-form');
  hide('role-toggle');
  document.getElementById('form-title').textContent = 'Create account';
  document.getElementById('form-sub').textContent = 'Join ProctorAI as a student';
  clearMessages();
}

function showLogin() {
  show('login-form');
  hide('register-form');
  document.getElementById('role-toggle').style.display = 'grid';
  document.getElementById('form-title').textContent = 'Welcome back';
  document.getElementById('form-sub').textContent = 'Sign in to access your dashboard';
  clearMessages();
}

/* ---- Messages ---- */
function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.style.display = 'block';
  document.getElementById('success-msg').style.display = 'none';
}

function showSuccess(msg) {
  const el = document.getElementById('success-msg');
  el.textContent = msg;
  el.style.display = 'block';
  document.getElementById('error-msg').style.display = 'none';
}

function clearMessages() {
  document.getElementById('error-msg').style.display = 'none';
  document.getElementById('success-msg').style.display = 'none';
}

/* ---- Button loading state ---- */
function setButtonLoading(btnId, spinnerId, textId, loading, text) {
  document.getElementById(btnId).disabled = loading;
  document.getElementById(spinnerId).style.display = loading ? 'block' : 'none';
  document.getElementById(textId).textContent = text;
}

/* ---- Login ---- */
async function doLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;

  if (!email || !password) return showError('Please fill in all fields.');

  setButtonLoading('login-btn', 'login-spinner', 'login-btn-text', true, 'Signing in…');
  clearMessages();

  try {
    const { ok, data } = await apiFetch('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, role: currentRole })
    });

    if (!ok) {
      showError(data.error || 'Login failed.');
    } else {
      localStorage.setItem('user', JSON.stringify(data.user));
      showSuccess('Login successful! Redirecting…');
      setTimeout(() => {
        window.location.href = data.user.role === 'proctor' ? 'proctor.html' : 'student.html';
      }, 800);
    }
  } catch (e) {
    showError('Cannot reach server. Make sure Flask is running on port 5000.');
  }

  setButtonLoading('login-btn', 'login-spinner', 'login-btn-text', false, 'Sign in');
}

async function doRegister() {
  const name     = document.getElementById('reg-name').value.trim();
  const email    = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const confirmPassword = document.getElementById('reg-password-confirm').value;

  if (!name || !email || !password) return showError('Please fill in all fields.');
  if (password !== confirmPassword) return showError('Passwords do not match.');

  setButtonLoading('reg-btn', 'reg-spinner', 'reg-btn-text', true, 'Creating…');
  clearMessages();

  try {
    const { ok, data } = await apiFetch('/api/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password })
    });

    if (!ok) {
      showError(data.error || 'Registration failed.');
    } else {
      showSuccess('Account created! Please sign in.');
      setTimeout(showLogin, 1200);
    }
  } catch (e) {
    showError('Cannot reach server.');
  }

  setButtonLoading('reg-btn', 'reg-spinner', 'reg-btn-text', false, 'Create account');
}

/* ---- Enter key support ---- */
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const registerVisible = document.getElementById('register-form').style.display === 'block';
  registerVisible ? doRegister() : doLogin();
});
