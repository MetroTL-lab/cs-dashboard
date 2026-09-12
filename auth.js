// --- Loading overlay --------------------------------------------------
// Shared by every page that includes auth.js. Reference-counted so that
// overlapping requests (e.g. an action's own call plus the list refresh
// it kicks off afterward) don't let one finishing early hide the modal
// while another is still in flight.
let _loadingCount = 0;
function showLoading(message = 'Loading…') {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  const msgEl = document.getElementById('loading-message');
  if (msgEl) msgEl.textContent = message;
  _loadingCount += 1;
  overlay.classList.add('visible');
}
function hideLoading() {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  _loadingCount = Math.max(0, _loadingCount - 1);
  if (_loadingCount === 0) overlay.classList.remove('visible');
}

// Shared across login.html and index.html. Creates one Supabase client
// using the ANON key — every privileged read/write from here on relies
// entirely on the RLS policies from migration 0060 recognizing the
// signed-in user as an admin, not on any elevated key living in this
// file.
const client = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// Set by requireAdminSession() once the signed-in user is confirmed to
// be in the admins table — dashboard.js reads this via getAdminRole()
// to decide which panels/actions to show. One of 'customer_experience',
// 'merchant_success', 'fleet_ops', or 'superuser' (migration 0071,
// 0072_rider_applications).
let _adminRole = null;
function getAdminRole() {
  return _adminRole;
}

/**
 * Confirms there's a live session AND that the session's user is in the
 * admins table. Returns the session on success; otherwise redirects to
 * login.html and returns null. Call this at the top of every dashboard
 * page — a valid Supabase Auth session alone is not enough, since
 * anyone can create an account, only rows in `admins` (added by hand,
 * see migration 0056's comment) actually unlock anything.
 */
async function requireAdminSession() {
  const { data: { session } } = await client.auth.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return null;
  }
  const { data: adminRow, error } = await client
    .from('admins')
    .select('id, role')
    .eq('id', session.user.id)
    .maybeSingle();
  if (error || !adminRow) {
    await client.auth.signOut();
    window.location.href = 'login.html?error=not_admin';
    return null;
  }
  _adminRole = adminRow.role;
  return session;
}

async function signOut() {
  showLoading('Signing out…');
  await client.auth.signOut();
  window.location.href = 'login.html';
}

// login.html's own form handler — no-ops on pages without #login-form.
const loginForm = document.getElementById('login-form');
if (loginForm) {
  const params = new URLSearchParams(window.location.search);
  if (params.get('error') === 'not_admin') {
    const el = document.getElementById('login-error');
    el.hidden = false;
    el.textContent = "That account isn't set up as an admin.";
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const btn = document.getElementById('login-btn');
    const errEl = document.getElementById('login-error');
    errEl.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    showLoading('Signing in…');

    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      hideLoading();
      errEl.hidden = false;
      errEl.textContent = error.message;
      btn.disabled = false;
      btn.textContent = 'Sign in';
      return;
    }

    // requireAdminSession() handles the "signed in but not an admin"
    // case with its own redirect + message.
    const session = await requireAdminSession();
    hideLoading();
    if (session) window.location.href = 'index.html';
  });
}