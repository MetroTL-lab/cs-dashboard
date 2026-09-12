let SESSION = null;
const PAGE_SIZE = 20;

function showToast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.hidden = true; }, 4000);
}

async function callFunction(name, body) {
  const response = await fetch(`${CONFIG.FUNCTIONS_URL}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SESSION.access_token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${name} failed`);
  return data;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// --- Reason modal -----------------------------------------------------
// Promise-based replacement for window.prompt(): shows a title, an
// editable textarea, and optional suggested messages (click one to fill
// the textarea -- it's still freely editable after). Resolves to the
// typed text on Submit, or null on Cancel/Escape/clicking outside --
// the same null-on-cancel contract window.prompt() had, so every
// existing `if (reason === null) return false;` caller only needed
// `await` added, nothing else.
function askForReason(title, suggestions = []) {
  const overlay = document.getElementById('reason-overlay');
  const titleEl = document.getElementById('reason-title');
  const suggestionsEl = document.getElementById('reason-suggestions');
  const input = document.getElementById('reason-input');
  const submitBtn = document.getElementById('reason-submit');
  const cancelBtn = document.getElementById('reason-cancel');

  return new Promise((resolve) => {
    titleEl.textContent = title;
    input.value = '';
    suggestionsEl.innerHTML = '';
    suggestions.forEach((text) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'suggestion-chip';
      chip.textContent = text;
      chip.addEventListener('click', () => {
        input.value = text;
        input.focus();
      });
      suggestionsEl.appendChild(chip);
    });

    function cleanup(result) {
      overlay.classList.remove('visible');
      submitBtn.removeEventListener('click', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('mousedown', onOverlayClick);
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    }
    function onSubmit() { cleanup(input.value); }
    function onCancel() { cleanup(null); }
    function onOverlayClick(e) { if (e.target === overlay) cleanup(null); }
    function onKeydown(e) {
      if (e.key === 'Escape') cleanup(null);
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) cleanup(input.value);
    }

    submitBtn.addEventListener('click', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('mousedown', onOverlayClick);
    document.addEventListener('keydown', onKeydown);

    overlay.classList.add('visible');
    setTimeout(() => input.focus(), 0);
  });
}

// --- Navigation -----------------------------------------------------------
// activatePanel is the single source of truth for "which section is
// showing" -- both sidebar clicks and programmatic navigation (store
// detail, opened from a card rather than the sidebar) go through it, so
// the two never disagree about what's on screen.

function activatePanel(panelId, navPanelId = panelId) {
  // Guard the single entry point every navigation path goes through
  // (sidebar clicks, stat-card shortcuts, store/message "back" links,
  // and any programmatic call) so a restricted panel can't be shown even
  // if something calls activatePanel() directly instead of clicking the
  // (hidden) nav button.
  if (!canAccessPanel(panelId, getAdminRole())) {
    console.warn(`Blocked navigation to "${panelId}" — not permitted for this role.`);
    panelId = 'overview';
    navPanelId = 'overview';
  }
  document.querySelectorAll('.panel-section').forEach((p) => p.classList.remove('active'));
  document.getElementById(`panel-${panelId}`).classList.add('active');
  document.querySelectorAll('.nav-link').forEach((b) => {
    b.classList.remove('active');
    b.removeAttribute('aria-current');
  });
  const activeLink = document.querySelector(`.nav-link[data-panel="${navPanelId}"]`);
  activeLink?.classList.add('active');
  activeLink?.setAttribute('aria-current', 'page');
}

function initNav() {
  document.querySelectorAll('.nav-link[data-panel]').forEach((btn) => {
    btn.addEventListener('click', () => activatePanel(btn.dataset.panel));
  });
  document.getElementById('signout-btn').addEventListener('click', signOut);
  document.getElementById('store-detail-back').addEventListener('click', () => activatePanel('sellers'));
  document.getElementById('message-thread-back').addEventListener('click', () => activatePanel('messages'));
}

// Overview's first three stat cards double as shortcuts into the panel
// they summarize (Active listings has no dedicated browsing panel, so
// it stays a plain, non-interactive stat).
function initStatCards() {
  document.querySelectorAll('.stat-card[data-panel]').forEach((btn) => {
    btn.addEventListener('click', () => activatePanel(btn.dataset.panel));
  });
}

// Filter/sort controls and "Load more" buttons for the three unbounded
// lists (Applications, Flagged products, Sellers & stores).
function initListControls() {
  document.getElementById('applications-load-more').addEventListener('click', () => loadApplications(false));
  document.getElementById('riders-load-more').addEventListener('click', () => loadRiderApplications(false));

  document.getElementById('flagged-filter').addEventListener('change', () => loadFlagged(true));
  document.getElementById('flagged-load-more').addEventListener('click', () => loadFlagged(false));

  document.getElementById('sellers-filter').addEventListener('change', () => loadSellers(true));
  document.getElementById('sellers-sort').addEventListener('change', () => loadSellers(true));
  document.getElementById('sellers-load-more').addEventListener('click', () => loadSellers(false));

  document.getElementById('reports-filter').addEventListener('change', () => loadUserReports(true));
  document.getElementById('reports-load-more').addEventListener('click', () => loadUserReports(false));
}

// --- Overview -----------------------------------------------------------

async function loadOverview() {
  showLoading('Loading overview…');
  try {
    const [pending, pendingRiders, flagged, stores, products, reports, conversations] = await Promise.all([
      client.from('admin_pending_applications').select('*', { count: 'exact', head: true }),
      client.from('admin_pending_rider_applications').select('*', { count: 'exact', head: true }),
      client.from('admin_flagged_products').select('*', { count: 'exact', head: true }),
      client.from('admin_seller_overview').select('*', { count: 'exact', head: true }),
      client.from('products').select('*', { count: 'exact', head: true }).eq('is_active', true),
      client.from('admin_user_reports').select('*', { count: 'exact', head: true }),
      client.from('admin_support_conversations').select('unread_count'),
    ]);

    // No server-side SUM in a plain select — admin_support_conversations
    // is small enough (one row per user who's ever messaged support)
    // that summing client-side is simpler than adding an RPC just for
    // this one number.
    const unreadMessages = (conversations.data || []).reduce((sum, c) => sum + (c.unread_count || 0), 0);

    document.getElementById('stat-pending').textContent = pending.count ?? '—';
    document.getElementById('stat-pending-riders').textContent = pendingRiders.count ?? '—';
    document.getElementById('stat-flagged').textContent = flagged.count ?? '—';
    document.getElementById('stat-stores').textContent = stores.count ?? '—';
    document.getElementById('stat-products').textContent = products.count ?? '—';
    document.getElementById('stat-reports').textContent = reports.count ?? '—';
    document.getElementById('stat-messages').textContent = unreadMessages;

    const appBadge = document.getElementById('badge-applications');
    const riderBadge = document.getElementById('badge-riders');
    const flagBadge = document.getElementById('badge-flagged');
    const reportsBadge = document.getElementById('badge-reports');
    const messagesBadge = document.getElementById('badge-messages');
    appBadge.textContent = pending.count ?? '';
    appBadge.hidden = !pending.count;
    riderBadge.textContent = pendingRiders.count ?? '';
    riderBadge.hidden = !pendingRiders.count;
    flagBadge.textContent = flagged.count ?? '';
    flagBadge.hidden = !flagged.count;
    reportsBadge.textContent = reports.count ?? '';
    reportsBadge.hidden = !reports.count;
    messagesBadge.textContent = unreadMessages || '';
    messagesBadge.hidden = !unreadMessages;
  } finally {
    hideLoading();
  }
}

// --- Applications -------------------------------------------------------

async function viewDocument(path, label) {
  if (!path) {
    showToast(`No ${label} on file for this application.`, true);
    return;
  }
  showLoading(`Opening ${label}…`);
  try {
    const { data, error } = await client.storage.from('seller-documents').createSignedUrl(path, 3600);
    if (error) {
      showToast(`Could not open ${label}.`, true);
      return;
    }
    window.open(data.signedUrl, '_blank', 'noopener');
  } finally {
    hideLoading();
  }
}

async function approveApplication(app) {
  assertPanelAccess('applications');
  showLoading('Approving application…');
  try {
    // IMPORTANT: .select() + checking `data` is required here. When RLS
    // blocks an update, Supabase/PostgREST does NOT return an `error` —
    // the UPDATE statement runs "successfully," it just matches zero
    // rows. Without .select(), `data` comes back null and there's no way
    // to tell "actually approved" apart from "silently no-opped because
    // this admin isn't allowed to." That gap used to let the code fall
    // through to sending the "approved" notification and the "success"
    // toast below even when nothing in the database changed — the
    // application would reappear on refresh, still pending, while the
    // applicant had already been told they were approved.
    const { data, error } = await client
      .from('seller_applications')
      .update({ status: 'approved', reviewed_by: SESSION.user.id, reviewed_at: new Date().toISOString() })
      .eq('id', app.application_id)
      .select('id');
    if (error) return showToast(error.message, true);
    if (!data || data.length === 0) {
      return showToast("Couldn't approve — you may not have permission to review applications.", true);
    }

    try {
      const result = await callFunction('send-application-status-email', {
        applicationId: app.application_id,
        userId: app.user_id,
        email: app.email,
        status: 'approved',
      });
      if (result.email && result.email.sent === false) {
        showToast(`Approved, but the email didn't send: ${result.email.error || 'unknown reason'}`, true);
      }
    } catch (e) {
      showToast(`Approved, but the notification email failed: ${e.message}`, true);
    }
    showToast(`${app.business_name} approved.`);
    loadApplications();
    loadOverview();
  } finally {
    hideLoading();
  }
}

async function rejectApplication(app) {
  assertPanelAccess('applications');
  const notes = await askForReason(
    `Notes for ${app.business_name} (shown to the applicant):`,
    [
      'Certificate is unreadable or expired — please resubmit.',
      "Business details don't match the certificate provided.",
      'This looks like a duplicate application.',
      "Doesn't currently meet our marketplace criteria.",
    ],
  );
  if (notes === null) return; // cancelled

  showLoading('Rejecting application…');
  try {
    // See the matching comment in approveApplication() — .select() is
    // required to distinguish "actually rejected" from "RLS silently
    // matched zero rows," which otherwise still sends the rejection
    // notification and shows a false success toast.
    const { data, error } = await client
      .from('seller_applications')
      .update({
        status: 'rejected',
        reviewed_by: SESSION.user.id,
        reviewed_at: new Date().toISOString(),
        review_notes: notes,
      })
      .eq('id', app.application_id)
      .select('id');
    if (error) return showToast(error.message, true);
    if (!data || data.length === 0) {
      return showToast("Couldn't reject — you may not have permission to review applications.", true);
    }

    try {
      const result = await callFunction('send-application-status-email', {
        applicationId: app.application_id,
        userId: app.user_id,
        email: app.email,
        status: 'rejected',
        reviewNotes: notes,
      });
      if (result.email && result.email.sent === false) {
        showToast(`Rejected, but the email didn't send: ${result.email.error || 'unknown reason'}`, true);
      }
    } catch (e) {
      showToast(`Rejected, but the notification email failed: ${e.message}`, true);
    }
    showToast(`${app.business_name} rejected.`);
    loadApplications();
    loadOverview();
  } finally {
    hideLoading();
  }
}

/** Manual fallback for the two automatic paths (immediate match at
 *  submission, or the signup trigger backfilling it later) — covers
 *  the case where neither catches it, e.g. the applicant used a
 *  different email in the app than on the form. Just a plain update —
 *  gated by "Merchant Success can update seller applications" (migration
 *  0071; superseded the old any-admin policy from migration 0060), so
 *  only Merchant Success/Superuser can actually link an application.
 */
async function linkApplicationToUser(app) {
  assertPanelAccess('applications');
  const phone = window.prompt(`Link "${app.business_name}" to the app account with this phone number:`, app.phone);
  if (!phone) return;

  showLoading('Linking application…');
  try {
    const { data: userId, error: lookupError } = await client.rpc('find_profile_id_by_phone', {
      p_phone: phone.trim(),
    });
    if (lookupError) return showToast(lookupError.message, true);
    if (!userId) return showToast(`No app account found with phone ${phone}.`, true);

    // See the comment in approveApplication() — .select() distinguishes
    // an actual update from one RLS silently no-op'd.
    const { data, error } = await client
      .from('seller_applications')
      .update({ user_id: userId })
      .eq('id', app.application_id)
      .select('id');
    if (error) return showToast(error.message, true);
    if (!data || data.length === 0) {
      return showToast("Couldn't link — you may not have permission to edit applications.", true);
    }

    showToast('Linked.');
    loadApplications();
  } finally {
    hideLoading();
  }
}

function applicationCard(app) {
  const card = document.createElement('div');
  card.className = 'card';

  const detailRow = (label, value) =>
    value ? `<p class="card-meta"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>` : '';

  const documentButtons = [
    ['cac', 'CAC certificate', app.business_cert_path],
    ['address', 'proof of address', app.proof_of_address_path],
    ['owner-id', "owner's ID", app.owner_id_path],
    ['logo', 'logo/catalog', app.store_logo_or_catalog_path],
  ]
    .filter(([, , path]) => path)
    .map(([slot, label, path]) => `<button class="btn-secondary" data-doc="${slot}" data-path="${escapeHtml(path)}">View ${escapeHtml(label)}</button>`)
    .join('');

  card.innerHTML = `
    <div class="card-title-row">
      <div>
        <p class="card-title">${escapeHtml(app.business_name)}</p>
        <p class="card-subtitle">${escapeHtml(app.full_name)} · ${escapeHtml(app.email)} · ${escapeHtml(app.phone)}</p>
      </div>
      <span class="status-chip ${app.user_id ? 'status-active' : 'status-inactive'}">
        ${app.user_id ? 'Linked to app account' : 'Not yet linked'}
      </span>
    </div>
    ${detailRow('Category', app.business_category)}
    ${detailRow('Monthly volume', app.monthly_volume)}
    ${detailRow('City', app.operating_city)}
    ${detailRow('Pickup address', app.pickup_address)}
    ${detailRow('Website/social', app.website_or_social)}
    ${detailRow('Services needed', (app.services_needed || []).join(', '))}
    ${detailRow('Registration no.', app.registration_number)}
    ${detailRow('Tax ID', app.tax_id_number)}
    ${detailRow('Bank', app.bank_name)}
    ${detailRow('Account name', app.bank_account_name)}
    ${detailRow('Account number', app.bank_account_number)}
    ${detailRow('Notes', app.notes)}
    <p class="card-meta">Applied ${formatDate(app.created_at)}</p>
    <div class="card-actions">
      ${documentButtons}
      ${app.user_id ? '' : '<button class="btn-secondary" data-action="link">Link to user by phone</button>'}
      <button class="btn-primary" data-action="approve">Approve</button>
      <button class="btn-danger" data-action="reject">Reject</button>
    </div>
  `;
  card.querySelector('[data-action="link"]')?.addEventListener('click', () => linkApplicationToUser(app));
  card.querySelectorAll('[data-doc]').forEach((btn) => {
    btn.addEventListener('click', () => viewDocument(btn.dataset.path, btn.textContent.replace('View ', '')));
  });
  card.querySelector('[data-action="approve"]').addEventListener('click', () => approveApplication(app));
  card.querySelector('[data-action="reject"]').addEventListener('click', () => rejectApplication(app));
  return card;
}

let applicationsOffset = 0;
let applicationsHasMore = true;

async function loadApplications(reset = true) {
  assertPanelAccess('applications');
  if (reset) {
    applicationsOffset = 0;
    applicationsHasMore = true;
    document.getElementById('applications-list').innerHTML = '';
  }
  showLoading('Loading applications…');
  try {
    const { data, error } = await client
      .from('admin_pending_applications')
      .select('*')
      .order('created_at', { ascending: true })
      .range(applicationsOffset, applicationsOffset + PAGE_SIZE - 1);
    const list = document.getElementById('applications-list');
    const empty = document.getElementById('applications-empty');
    const loadMoreBtn = document.getElementById('applications-load-more');
    if (error) return showToast(error.message, true);
    if (reset) empty.hidden = data.length > 0;
    data.forEach((app) => list.appendChild(applicationCard(app)));
    applicationsOffset += data.length;
    applicationsHasMore = data.length === PAGE_SIZE;
    loadMoreBtn.hidden = !applicationsHasMore;
  } finally {
    hideLoading();
  }
}

// --- Rider applications ---------------------------------------------------
// Same shape as the Applications panel above (approve/reject/link by
// phone) — kept as its own set of functions rather than parameterizing
// the seller ones, since the two tables' fields genuinely differ (no
// documents here) and Fleet Ops/Merchant Success are gated separately.

function riderApplicationCard(app) {
  const card = document.createElement('div');
  card.className = 'card';

  const detailRow = (label, value) =>
    value ? `<p class="card-meta"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>` : '';

  card.innerHTML = `
    <div class="card-title-row">
      <div>
        <p class="card-title">${escapeHtml(app.full_name)}</p>
        <p class="card-subtitle">${escapeHtml(app.email)} · ${escapeHtml(app.phone)}</p>
      </div>
      <span class="status-chip ${app.user_id ? 'status-active' : 'status-inactive'}">
        ${app.user_id ? 'Linked to app account' : 'Not yet linked'}
      </span>
    </div>
    ${detailRow('City', app.city)}
    ${detailRow('Vehicle category', app.vehicle_category)}
    ${detailRow('Has vehicle', app.has_vehicle)}
    ${detailRow('License number', app.license_number)}
    ${detailRow('Experience', app.experience_years)}
    ${detailRow('Residential address', app.residential_address)}
    ${detailRow('Guarantor available', app.guarantor_available)}
    ${detailRow('Notes', app.notes)}
    <p class="card-meta">Applied ${formatDate(app.created_at)}</p>
    <div class="card-actions">
      ${app.user_id ? '' : '<button class="btn-secondary" data-action="link">Link to user by phone</button>'}
      <button class="btn-primary" data-action="approve">Approve</button>
      <button class="btn-danger" data-action="reject">Reject</button>
    </div>
  `;
  card.querySelector('[data-action="link"]')?.addEventListener('click', () => linkRiderApplicationToUser(app));
  card.querySelector('[data-action="approve"]').addEventListener('click', () => approveRiderApplication(app));
  card.querySelector('[data-action="reject"]').addEventListener('click', () => rejectRiderApplication(app));
  return card;
}

let ridersOffset = 0;
let ridersHasMore = true;

async function loadRiderApplications(reset = true) {
  assertPanelAccess('riders');
  if (reset) {
    ridersOffset = 0;
    ridersHasMore = true;
    document.getElementById('riders-list').innerHTML = '';
  }
  showLoading('Loading rider applications…');
  try {
    const { data, error } = await client
      .from('admin_pending_rider_applications')
      .select('*')
      .order('created_at', { ascending: true })
      .range(ridersOffset, ridersOffset + PAGE_SIZE - 1);
    const list = document.getElementById('riders-list');
    const empty = document.getElementById('riders-empty');
    const loadMoreBtn = document.getElementById('riders-load-more');
    if (error) return showToast(error.message, true);
    if (reset) empty.hidden = data.length > 0;
    data.forEach((app) => list.appendChild(riderApplicationCard(app)));
    ridersOffset += data.length;
    ridersHasMore = data.length === PAGE_SIZE;
    loadMoreBtn.hidden = !ridersHasMore;
  } finally {
    hideLoading();
  }
}

async function approveRiderApplication(app) {
  assertPanelAccess('riders');
  showLoading('Approving application…');
  try {
    // See the matching comment in approveApplication() — .select() is
    // required to distinguish an actual approval from RLS silently
    // matching zero rows.
    const { data, error } = await client
      .from('rider_applications')
      .update({ status: 'approved', reviewed_by: SESSION.user.id, reviewed_at: new Date().toISOString() })
      .eq('id', app.application_id)
      .select('id');
    if (error) return showToast(error.message, true);
    if (!data || data.length === 0) {
      return showToast("Couldn't approve — you may not have permission to review rider applications.", true);
    }
    showToast(`${app.full_name} approved.`);
    loadRiderApplications();
    loadOverview();
  } finally {
    hideLoading();
  }
}

async function rejectRiderApplication(app) {
  assertPanelAccess('riders');
  const notes = await askForReason(
    `Notes for ${app.full_name} (shown to the applicant):`,
    [
      "Details don't match what's required for this vehicle category.",
      'Could not verify residential address.',
      'This looks like a duplicate application.',
      "Doesn't currently meet our rider criteria.",
    ],
  );
  if (notes === null) return; // cancelled

  showLoading('Rejecting application…');
  try {
    const { data, error } = await client
      .from('rider_applications')
      .update({
        status: 'rejected',
        reviewed_by: SESSION.user.id,
        reviewed_at: new Date().toISOString(),
        review_notes: notes,
      })
      .eq('id', app.application_id)
      .select('id');
    if (error) return showToast(error.message, true);
    if (!data || data.length === 0) {
      return showToast("Couldn't reject — you may not have permission to review rider applications.", true);
    }
    showToast(`${app.full_name} rejected.`);
    loadRiderApplications();
    loadOverview();
  } finally {
    hideLoading();
  }
}

/** Manual fallback, same reasoning as linkApplicationToUser() above. */
async function linkRiderApplicationToUser(app) {
  assertPanelAccess('riders');
  const phone = window.prompt(`Link "${app.full_name}" to the app account with this phone number:`, app.phone);
  if (!phone) return;

  showLoading('Linking application…');
  try {
    const { data: userId, error: lookupError } = await client.rpc('find_profile_id_by_phone', {
      p_phone: phone.trim(),
    });
    if (lookupError) return showToast(lookupError.message, true);
    if (!userId) return showToast(`No app account found with phone ${phone}.`, true);

    const { data, error } = await client
      .from('rider_applications')
      .update({ user_id: userId })
      .eq('id', app.application_id)
      .select('id');
    if (error) return showToast(error.message, true);
    if (!data || data.length === 0) {
      return showToast("Couldn't link — you may not have permission to edit rider applications.", true);
    }

    showToast('Linked.');
    loadRiderApplications();
  } finally {
    hideLoading();
  }
}

// --- Product moderation (shared across Flagged, Store detail, Search) -----

const STATUS_LABEL = {
  warned: 'Warned',
  appeal_pending: 'Appeal pending',
  taken_down: 'Taken down',
};

// Suggested reasons shown in the reason modal, keyed by the moderation
// action that needs one. Purely a head start for the admin -- the
// textarea is always freely editable, and an action with no entry here
// (or one that doesn't need a reason at all) just shows no suggestions.
const MODERATION_REASON_SUGGESTIONS = {
  forced_takedown: [
    'Still violates policy after the warning.',
    'Seller did not respond to the warning.',
    'New reports confirm the same issue.',
  ],
  appeal_denied: [
    "Appeal doesn't address the original issue.",
    'Insufficient evidence provided in the appeal.',
    'Violation confirmed on review.',
  ],
  flagged_bad_goods: [
    'Appears to be counterfeit.',
    "Item doesn't match its description.",
    'Prohibited or unsafe goods.',
  ],
  policy_takedown: [
    'Prohibited item category.',
    'Violates marketplace listing policy.',
    'Misleading or false claims in the listing.',
  ],
};

/** Returns action button HTML appropriate to a product's current
 *  moderation_status -- anything not warned/appeal_pending/taken_down is
 *  treated as active (the two entry actions apply). Shared by every
 *  place a product card can appear, so the rules only live in one spot.
 */
function moderationActionsHtml(status) {
  switch (status) {
    case 'warned':
      return `<button class="btn-danger" data-action="force">Force takedown</button>`;
    case 'appeal_pending':
      return `
        <button class="btn-primary" data-action="approve-appeal">Approve appeal</button>
        <button class="btn-danger" data-action="deny-appeal">Deny appeal</button>
      `;
    case 'taken_down':
      return `<button class="btn-secondary" data-action="reinstate">Reinstate</button>`;
    default:
      return `
        <button class="btn-danger" data-action="flag">Flag as bad goods</button>
        <button class="btn-danger" data-action="policy">Policy takedown</button>
      `;
  }
}

/** Attaches listeners for whichever of the buttons above are actually
 *  present on `card` -- the optional-chaining calls are all no-ops for
 *  buttons that weren't rendered for this product's status.
 */
function wireModerationActions(card, productId, onDone) {
  card.querySelector('[data-action="force"]')?.addEventListener('click', () =>
    moderationAction(productId, 'forced_takedown', true).then((ok) => ok && onDone()));
  card.querySelector('[data-action="approve-appeal"]')?.addEventListener('click', () =>
    moderationAction(productId, 'appeal_approved', false).then((ok) => ok && onDone()));
  card.querySelector('[data-action="deny-appeal"]')?.addEventListener('click', () =>
    moderationAction(productId, 'appeal_denied', true).then((ok) => ok && onDone()));
  card.querySelector('[data-action="reinstate"]')?.addEventListener('click', () =>
    moderationAction(productId, 'reinstated', false).then((ok) => ok && onDone()));
  card.querySelector('[data-action="flag"]')?.addEventListener('click', () =>
    moderationAction(productId, 'flagged_bad_goods', true).then((ok) => ok && onDone()));
  card.querySelector('[data-action="policy"]')?.addEventListener('click', () =>
    moderationAction(productId, 'policy_takedown', true).then((ok) => ok && onDone()));
}

/** Inserts the moderation_actions row, emails the seller, and refreshes
 *  the overview counts (always relevant regardless of where this was
 *  called from). Returns whether it actually went through, so callers
 *  can decide what -- if anything -- to refresh locally.
 */
async function moderationAction(productId, action, needsReason) {
  // Shared by both flagged-products actions and report-driven actions;
  // 'flagged' and 'reports' have the same allowed roles, so checking
  // either key here is equivalent.
  assertPanelAccess('flagged');
  let reason;
  if (needsReason) {
    reason = await askForReason(
      'Reason (shown to the seller in the notice/email):',
      MODERATION_REASON_SUGGESTIONS[action] || [],
    );
    if (reason === null) return false; // cancelled
  }

  showLoading('Applying action…');
  try {
    const { error } = await client.from('moderation_actions').insert({
      product_id: productId,
      admin_id: SESSION.user.id,
      action,
      reason: reason || null,
    });
    if (error) {
      showToast(error.message, true);
      return false;
    }

    try {
      const result = await callFunction('send-moderation-email', { productId, action, reason });
      if (result.email && result.email.sent === false && !result.skipped) {
        showToast(`Action applied, but the email didn't send: ${result.email.error || 'unknown reason'}`, true);
      }
    } catch (e) {
      showToast(`Action applied, but the notification email failed: ${e.message}`, true);
    }
    showToast('Done.');
    loadOverview();
    return true;
  } finally {
    hideLoading();
  }
}

// --- Flagged products -----------------------------------------------------

function flaggedCard(p) {
  const card = document.createElement('div');
  card.className = 'card';
  const notice = p.moderation_notice || p.takedown_reason;
  card.innerHTML = `
    <div class="card-title-row">
      <div>
        <p class="card-title">${escapeHtml(p.title)}</p>
        <p class="card-subtitle">${escapeHtml(p.seller_name)} · ${escapeHtml(p.seller_email)}${p.store_name ? ' · ' + escapeHtml(p.store_name) : ''}</p>
      </div>
      <span class="status-chip status-${p.moderation_status}">${STATUS_LABEL[p.moderation_status] || p.moderation_status}</span>
    </div>
    <p class="card-meta">${p.report_count} report${p.report_count === 1 ? '' : 's'} · ${p.has_used_appeal ? 'already used its one appeal' : 'appeal available'}</p>
    ${notice ? `<p class="card-notice">${escapeHtml(notice)}</p>` : ''}
    <div class="card-actions">${moderationActionsHtml(p.moderation_status)}</div>
  `;
  wireModerationActions(card, p.product_id, loadFlagged);
  return card;
}

let flaggedOffset = 0;
let flaggedHasMore = true;

async function loadFlagged(reset = true) {
  assertPanelAccess('flagged');
  if (reset) {
    flaggedOffset = 0;
    flaggedHasMore = true;
    document.getElementById('flagged-list').innerHTML = '';
  }
  showLoading('Loading flagged products…');
  try {
    const statusFilter = document.getElementById('flagged-filter').value;
    let query = client.from('admin_flagged_products').select('*').order('updated_at', { ascending: false });
    if (statusFilter !== 'all') query = query.eq('moderation_status', statusFilter);
    query = query.range(flaggedOffset, flaggedOffset + PAGE_SIZE - 1);

    const { data, error } = await query;
    const list = document.getElementById('flagged-list');
    const empty = document.getElementById('flagged-empty');
    const loadMoreBtn = document.getElementById('flagged-load-more');
    if (error) return showToast(error.message, true);
    if (reset) empty.hidden = data.length > 0;
    data.forEach((p) => list.appendChild(flaggedCard(p)));
    flaggedOffset += data.length;
    flaggedHasMore = data.length === PAGE_SIZE;
    loadMoreBtn.hidden = !flaggedHasMore;
  } finally {
    hideLoading();
  }
}

// --- User reports -----------------------------------------------------------
// Append-only log — product_reports/store_reports (migrations 0057,
// 0063) have no update/delete policy for admins, so there's no
// "dismiss" here, only quick actions that act on the underlying
// product/store. A report stays listed even after you've acted on it;
// see the note on this in the delivery for this feature if that turns
// out to be annoying in practice — it's a small follow-up (a
// resolved_at column + filter) rather than a redesign.

let reportsOffset = 0;
let reportsHasMore = true;

function reportCard(report) {
  const card = document.createElement('div');
  card.className = 'card';
  const isProduct = report.target_type === 'product';
  card.innerHTML = `
    <div class="card-title-row">
      <div>
        <p class="card-title">${escapeHtml(report.target_name)}</p>
        <p class="card-subtitle">${isProduct ? 'Product' : 'Store'} · reported by ${escapeHtml(report.reporter_name || report.reporter_email || 'a user')}</p>
      </div>
    </div>
    <p class="card-meta">${formatDate(report.created_at)}</p>
    <p class="card-notice">${escapeHtml(report.reason)}</p>
    <div class="card-actions">
      ${isProduct
        ? '<button class="btn-danger" data-action="flag">Flag as bad goods</button>'
        : '<button class="btn-danger" data-action="deactivate">Deactivate store</button>'}
    </div>
  `;
  card.querySelector('[data-action="flag"]')?.addEventListener('click', () =>
    moderationAction(report.target_id, 'flagged_bad_goods', true).then((ok) => ok && loadFlagged(true)));
  card.querySelector('[data-action="deactivate"]')?.addEventListener('click', async () => {
    const ok = await storeModerationAction(
      report.target_id,
      'deactivated',
      `Reason for deactivating "${report.target_name}" (shown to the owner, by email and in the app):`,
      STORE_REASON_SUGGESTIONS.deactivated,
    );
    if (ok) loadSellers(true);
  });
  return card;
}

async function loadUserReports(reset = true) {
  assertPanelAccess('reports');
  if (reset) {
    reportsOffset = 0;
    reportsHasMore = true;
    document.getElementById('reports-list').innerHTML = '';
  }
  showLoading('Loading reports…');
  try {
    const typeFilter = document.getElementById('reports-filter').value;
    let query = client.from('admin_user_reports').select('*').order('created_at', { ascending: false });
    if (typeFilter !== 'all') query = query.eq('target_type', typeFilter);
    query = query.range(reportsOffset, reportsOffset + PAGE_SIZE - 1);

    const { data, error } = await query;
    const list = document.getElementById('reports-list');
    const empty = document.getElementById('reports-empty');
    const loadMoreBtn = document.getElementById('reports-load-more');
    if (error) return showToast(error.message, true);
    if (reset) empty.hidden = data.length > 0;
    data.forEach((r) => list.appendChild(reportCard(r)));
    reportsOffset += data.length;
    reportsHasMore = data.length === PAGE_SIZE;
    loadMoreBtn.hidden = !reportsHasMore;
  } finally {
    hideLoading();
  }
}

// --- Sellers & stores -------------------------------------------------------

// Same idea as MODERATION_REASON_SUGGESTIONS, one level up (store
// actions rather than product actions).
const STORE_REASON_SUGGESTIONS = {
  deactivated: [
    'Multiple confirmed policy violations.',
    'Repeated user complaints.',
    'Failed verification checks.',
  ],
  appeal_denied: [
    "Appeal doesn't address the original violation.",
    'Insufficient evidence provided.',
    'Additional violations found during review.',
  ],
};

/** Store-level equivalent of moderationAction() — inserts into
 *  store_moderation_actions (not a raw `stores` update: migration
 *  0062's protect trigger only allows deactivation_reason/
 *  appeal_available/etc. to change through this table, since those
 *  columns need a paired reason + owner notification every time they
 *  change, not just a silent flag flip). promptMessage is the reason
 *  modal's title, shown when the action needs a reason; pass
 *  null/undefined to skip it entirely (appeal_approved, reactivated).
 */
async function storeModerationAction(storeId, action, promptMessage, suggestions = []) {
  let reason;
  if (promptMessage) {
    reason = await askForReason(promptMessage, suggestions);
    if (reason === null) return false; // cancelled
  }

  showLoading('Applying action…');
  try {
    const { error } = await client.from('store_moderation_actions').insert({
      store_id: storeId,
      admin_id: SESSION.user.id,
      action,
      reason: reason || null,
    });
    if (error) {
      showToast(error.message, true);
      return false;
    }

    try {
      const result = await callFunction('send-store-moderation-email', { storeId, action, reason });
      if (result.email && result.email.sent === false && !result.skipped) {
        showToast(`Action applied, but the email didn't send: ${result.email.error || 'unknown reason'}`, true);
      }
    } catch (e) {
      showToast(`Action applied, but the notification email failed: ${e.message}`, true);
    }
    showToast('Done.');
    loadOverview();
    return true;
  } finally {
    hideLoading();
  }
}

async function toggleStoreActive(store) {
  if (store.store_is_active) {
    const ok = await storeModerationAction(
      store.store_id,
      'deactivated',
      `Reason for deactivating "${store.store_name}" (shown to the owner, by email and in the app):`,
      STORE_REASON_SUGGESTIONS.deactivated,
    );
    if (ok) loadSellers(true);
  } else {
    const ok = await storeModerationAction(store.store_id, 'reactivated', null);
    if (ok) loadSellers(true);
  }
}

async function approveStoreAppeal(store) {
  const ok = await storeModerationAction(store.store_id, 'appeal_approved', null);
  if (ok) loadSellers(true);
}

async function denyStoreAppeal(store) {
  const ok = await storeModerationAction(
    store.store_id,
    'appeal_denied',
    `Reason for denying the appeal for "${store.store_name}" (shown to the owner):`,
    STORE_REASON_SUGGESTIONS.appeal_denied,
  );
  if (ok) loadSellers(true);
}

async function deleteSellerAccount(store) {
  const confirmed = window.confirm(
    `Delete ${store.owner_name || store.owner_email}'s account?\n\nThis permanently scrubs their personal data and blocks them from logging in. Their store and listings will be hidden but order history is preserved. This cannot be undone.`,
  );
  if (!confirmed) return;

  showLoading('Deleting account…');
  try {
    await callFunction('admin-delete-user', { targetUserId: store.owner_id });
    showToast('Account deleted.');
    loadSellers();
    loadOverview();
  } catch (e) {
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

/** Used both in the Sellers & stores list and in search results -- one
 *  card definition, reused wherever a store can appear. Clicking the
 *  store name (or "View products") opens the store detail view.
 */
function sellerCard(store) {
  const card = document.createElement('div');
  card.className = 'card';
  const isSuperuser = getAdminRole() === 'superuser';
  const statusLabel = store.store_is_active ? 'Active' : (store.appeal_pending ? 'Appeal pending' : 'Deactivated');
  const statusClass = store.store_is_active ? 'status-active' : (store.appeal_pending ? 'status-appeal_pending' : 'status-inactive');
  const appealNote = store.store_is_active
    ? ''
    : store.appeal_pending
      ? ' · awaiting your review'
      : store.appeal_available
        ? ' · appeal available to owner'
        : ' · already used its one appeal';
  card.innerHTML = `
    <div class="card-title-row">
      <div>
        <p class="card-title card-title-link" data-action="view">${escapeHtml(store.store_name)}</p>
        <p class="card-subtitle">${escapeHtml(store.owner_name || 'Unnamed')} · ${escapeHtml(store.owner_email || '')}</p>
      </div>
      <span class="status-chip ${statusClass}">${statusLabel}</span>
    </div>
    <p class="card-meta">${store.product_count} listing${store.product_count === 1 ? '' : 's'} · ${store.flagged_product_count} flagged${appealNote}</p>
    ${store.deactivation_reason ? `<p class="card-notice">${escapeHtml(store.deactivation_reason)}</p>` : ''}
    <div class="card-actions">
      <button class="btn-secondary" data-action="view">View products</button>
      ${isSuperuser && store.appeal_pending ? '<button class="btn-primary" data-action="approve-appeal">Approve appeal</button><button class="btn-danger" data-action="deny-appeal">Deny appeal</button>' : ''}
      ${isSuperuser ? `<button class="btn-secondary" data-action="toggle">${store.store_is_active ? 'Deactivate store' : 'Reactivate store'}</button>` : ''}
      ${isSuperuser ? '<button class="btn-danger" data-action="delete">Delete account</button>' : ''}
    </div>
  `;
  card.querySelectorAll('[data-action="view"]').forEach((el) => el.addEventListener('click', () => viewStoreDetail(store)));
  card.querySelector('[data-action="toggle"]')?.addEventListener('click', () => toggleStoreActive(store));
  card.querySelector('[data-action="delete"]')?.addEventListener('click', () => deleteSellerAccount(store));
  card.querySelector('[data-action="approve-appeal"]')?.addEventListener('click', () => approveStoreAppeal(store));
  card.querySelector('[data-action="deny-appeal"]')?.addEventListener('click', () => denyStoreAppeal(store));
  return card;
}

let sellersOffset = 0;
let sellersHasMore = true;

async function loadSellers(reset = true) {
  if (reset) {
    sellersOffset = 0;
    sellersHasMore = true;
    document.getElementById('sellers-list').innerHTML = '';
  }
  showLoading('Loading sellers…');
  try {
    const statusFilter = document.getElementById('sellers-filter').value;
    const sortBy = document.getElementById('sellers-sort').value;

    let query = client.from('admin_seller_overview').select('*');
    if (statusFilter === 'active') query = query.eq('store_is_active', true);
    if (statusFilter === 'inactive') query = query.eq('store_is_active', false);

    if (sortBy === 'flagged_desc') query = query.order('flagged_product_count', { ascending: false }).order('store_name');
    else if (sortBy === 'listings_desc') query = query.order('product_count', { ascending: false }).order('store_name');
    else query = query.order('store_name');

    query = query.range(sellersOffset, sellersOffset + PAGE_SIZE - 1);

    const { data, error } = await query;
    const list = document.getElementById('sellers-list');
    const empty = document.getElementById('sellers-empty');
    const loadMoreBtn = document.getElementById('sellers-load-more');
    if (error) return showToast(error.message, true);
    if (reset) empty.hidden = data.length > 0;
    data.forEach((s) => list.appendChild(sellerCard(s)));
    sellersOffset += data.length;
    sellersHasMore = data.length === PAGE_SIZE;
    loadMoreBtn.hidden = !sellersHasMore;
  } finally {
    hideLoading();
  }
}

// --- Store detail (products within one store) ------------------------------

let currentStoreDetail = null;

function storeProductCard(p) {
  const card = document.createElement('div');
  card.className = 'card';
  const isSuperuser = getAdminRole() === 'superuser';
  const notice = p.moderation_notice || p.takedown_reason;
  const status = p.moderation_status === 'active' && !p.is_active ? 'inactive' : p.moderation_status;
  card.innerHTML = `
    <div class="card-title-row">
      <div><p class="card-title">${escapeHtml(p.title)}</p></div>
      ${status !== 'active' ? `<span class="status-chip status-${status}">${status === 'inactive' ? 'Paused by seller' : (STATUS_LABEL[status] || status)}</span>` : ''}
    </div>
    ${notice ? `<p class="card-notice">${escapeHtml(notice)}</p>` : ''}
    <div class="card-actions">
      ${moderationActionsHtml(p.moderation_status)}
      ${isSuperuser ? '<button class="btn-secondary" data-action="edit-listing">Edit listing</button>' : ''}
      ${isSuperuser ? '<button class="btn-danger" data-action="delete-listing">Delete listing</button>' : ''}
    </div>
  `;
  wireModerationActions(card, p.id, () => viewStoreDetail(currentStoreDetail));
  card.querySelector('[data-action="edit-listing"]')?.addEventListener('click', () => editListing(p));
  card.querySelector('[data-action="delete-listing"]')?.addEventListener('click', () => deleteListing(p));
  return card;
}

async function deleteListing(product) {
  const confirmed = window.confirm(`Permanently delete "${product.title}"? This cannot be undone.`);
  if (!confirmed) return;
  showLoading('Deleting listing…');
  try {
    const { error } = await client.from('products').delete().eq('id', product.id);
    if (error) return showToast(error.message, true);
    showToast('Listing deleted.');
    viewStoreDetail(currentStoreDetail);
    loadOverview();
  } finally {
    hideLoading();
  }
}

async function viewStoreDetail(store) {
  currentStoreDetail = store;
  activatePanel('store-detail', 'sellers');
  document.getElementById('store-detail-title').textContent = store.store_name;
  document.getElementById('store-detail-subtitle').textContent =
    `${store.owner_name || 'Unnamed'} · ${store.owner_email || ''}`;

  const isSuperuser = getAdminRole() === 'superuser';
  const controls = document.getElementById('store-detail-superuser-controls');
  controls.hidden = !isSuperuser;

  const list = document.getElementById('store-detail-list');
  const empty = document.getElementById('store-detail-empty');
  list.innerHTML = '';
  empty.hidden = true;

  showLoading('Loading store…');
  try {
    const { data, error } = await client
      .from('products')
      .select('id, title, is_active, moderation_status, moderation_notice, takedown_reason')
      .eq('store_id', store.store_id)
      .order('title');

    if (error) return showToast(error.message, true);
    empty.hidden = data.length > 0;
    data.forEach((p) => list.appendChild(storeProductCard(p)));
  } finally {
    hideLoading();
  }
}

// --- User messages (support chat) ------------------------------------------
// Backed by migration 0064: the app's chat has been support-only since
// migration 0043 — every conversation has ONE designated support
// account as a participant (get_support_account_id()), and this section
// lets any admin reply as that single identity, so a user always sees
// one continuous "Support" thread no matter which admin is on shift.
// SUPPORT_ACCOUNT_ID is resolved once at boot and reused for every
// send/read-check in this section.

let SUPPORT_ACCOUNT_ID = null;

function messageInboxRow(convo) {
  const row = document.createElement('div');
  row.className = 'card message-inbox-row';
  const preview = convo.last_message && convo.last_message.trim()
    ? convo.last_message
    : convo.last_message_attachment_type === 'image'
      ? '📷 Photo'
      : convo.last_message_attachment_type
        ? '📎 Attachment'
        : 'No messages yet';
  row.innerHTML = `
    <div>
      <p class="card-title">${escapeHtml(convo.user_name || convo.user_email || 'User')}</p>
      <p class="card-subtitle">${escapeHtml(preview)}</p>
    </div>
    <div style="text-align:right; flex-shrink:0;">
      <p class="card-meta">${convo.last_message_at ? formatDate(convo.last_message_at) : ''}</p>
      ${convo.unread_count ? `<span class="nav-badge">${convo.unread_count}</span>` : ''}
    </div>
  `;
  row.addEventListener('click', () => openMessageThread(convo));
  return row;
}

async function loadUserMessages() {
  assertPanelAccess('messages');
  showLoading('Loading messages…');
  try {
    const { data, error } = await client
      .from('admin_support_conversations')
      .select('*')
      .order('last_message_at', { ascending: false, nullsFirst: false });
    const list = document.getElementById('messages-list');
    const empty = document.getElementById('messages-empty');
    list.innerHTML = '';
    if (error) return showToast(error.message, true);
    empty.hidden = data.length > 0;
    data.forEach((c) => list.appendChild(messageInboxRow(c)));
  } finally {
    hideLoading();
  }
}

// Renders a message's attachment (if any) above its text, same layout
// the app's own chat bubble uses — an image thumbnail (click to open
// full-size in a new tab) for attachment_type 'image', or a small file
// chip for anything else. A message can be attachment-only (empty
// body — see conversation_screen.dart's _send(): "(body.isEmpty &&
// !hasAttachment)" is the only thing that blocks sending), so the text
// line is only rendered when body is non-empty.
function messageBubble(message) {
  const isSupport = message.sender_id === SUPPORT_ACCOUNT_ID;
  const row = document.createElement('div');
  row.className = `message-bubble-row ${isSupport ? 'from-support' : 'from-user'}`;
  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${isSupport ? 'from-support' : 'from-user'}`;

  let attachmentHtml = '';
  if (message.attachment_url) {
    attachmentHtml = message.attachment_type === 'image'
      ? `<img src="${message.attachment_url}" alt="Attachment" class="message-bubble-image" data-action="open-attachment" />`
      : `<a href="${message.attachment_url}" target="_blank" rel="noopener" class="message-bubble-file">📎 ${escapeHtml(message.attachment_name || 'Attachment')}</a>`;
  }
  const bodyHtml = message.body && message.body.trim() ? `<div>${escapeHtml(message.body)}</div>` : '';
  bubble.innerHTML = `${attachmentHtml}${bodyHtml}<span class="message-bubble-time">${formatDate(message.created_at)}</span>`;
  bubble.querySelector('[data-action="open-attachment"]')?.addEventListener('click', () => {
    window.open(message.attachment_url, '_blank', 'noopener');
  });
  row.appendChild(bubble);
  return row;
}

let currentThreadConversationId = null;
let messageReplyPhotoPicker;

async function openMessageThread(convo) {
  assertPanelAccess('messages');
  currentThreadConversationId = convo.conversation_id;
  activatePanel('message-thread', 'messages');
  document.getElementById('message-thread-title').textContent = convo.user_name || 'User';
  document.getElementById('message-thread-subtitle').textContent = convo.user_email || '';
  document.getElementById('message-reply-input').value = '';
  messageReplyPhotoPicker.reset(null);

  const list = document.getElementById('message-thread-list');
  list.innerHTML = '';

  const { data, error } = await client
    .from('messages')
    .select('*')
    .eq('conversation_id', convo.conversation_id)
    .order('created_at', { ascending: true });
  if (error) {
    showToast(error.message, true);
    return;
  }
  data.forEach((m) => list.appendChild(messageBubble(m)));
  list.scrollTop = list.scrollHeight;

  if (convo.unread_count) {
    await client
      .from('messages')
      .update({ is_read: true })
      .eq('conversation_id', convo.conversation_id)
      .neq('sender_id', SUPPORT_ACCOUNT_ID)
      .eq('is_read', false);
    loadOverview();
  }
}

async function uploadChatAttachmentFile(file, conversationId) {
  const fileBase64 = await fileToBase64(file);
  const filename = `${Date.now()}_${(file.name || 'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const { publicUrl } = await callFunction('upload-chat-attachment', {
    conversationId,
    fileBase64,
    filename,
    contentType: file.type || 'image/jpeg',
  });
  return publicUrl;
}

async function sendSupportReply(event) {
  event.preventDefault();
  const input = document.getElementById('message-reply-input');
  const body = input.value.trim();
  const attachmentEntry = messageReplyPhotoPicker.getEntries()[0];
  if (!body && !attachmentEntry) return;
  if (!currentThreadConversationId) return;

  showLoading(attachmentEntry ? 'Uploading photo…' : 'Sending…');
  try {
    const attachmentUrl = attachmentEntry
      ? (attachmentEntry.file
          ? await uploadChatAttachmentFile(attachmentEntry.file, currentThreadConversationId)
          : attachmentEntry.existingUrl)
      : null;

    const { error } = await client.from('messages').insert({
      conversation_id: currentThreadConversationId,
      sender_id: SUPPORT_ACCOUNT_ID,
      body,
      attachment_url: attachmentUrl,
      attachment_type: attachmentUrl ? 'image' : null,
      attachment_name: attachmentUrl ? (attachmentEntry.file?.name || 'photo.jpg') : null,
    });
    if (error) return showToast(error.message, true);

    input.value = '';
    messageReplyPhotoPicker.reset(null);
    const list = document.getElementById('message-thread-list');
    list.appendChild(messageBubble({
      sender_id: SUPPORT_ACCOUNT_ID,
      body,
      created_at: new Date().toISOString(),
      attachment_url: attachmentUrl,
      attachment_type: attachmentUrl ? 'image' : null,
      attachment_name: attachmentUrl ? (attachmentEntry.file?.name || 'photo.jpg') : null,
    }));
    list.scrollTop = list.scrollHeight;
    loadUserMessages();
  } catch (e) {
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

function initMessages() {
  messageReplyPhotoPicker = createPhotoPicker({
    inputId: 'message-reply-attachment-input',
    previewId: 'message-reply-attachment-preview',
    btnId: 'message-reply-attach-btn',
    multi: false,
  });
  document.getElementById('message-reply-form').addEventListener('submit', sendSupportReply);
}

// --- Search (stores and products together) ---------------------------------

function productSearchCard(product) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-title-row">
      <div><p class="card-title">${escapeHtml(product.title)}</p></div>
      ${product.moderation_status !== 'active' ? `<span class="status-chip status-${product.moderation_status}">${STATUS_LABEL[product.moderation_status] || product.moderation_status}</span>` : ''}
    </div>
    <div class="card-actions">${moderationActionsHtml(product.moderation_status)}</div>
  `;
  wireModerationActions(card, product.id, loadSearchResults);
  return card;
}

let lastSearchQuery = '';

async function loadSearchResults() {
  assertPanelAccess('search');
  const q = lastSearchQuery.trim();
  const appsHeading = document.getElementById('search-applications-heading');
  const storesHeading = document.getElementById('search-stores-heading');
  const productsHeading = document.getElementById('search-products-heading');
  const appsList = document.getElementById('search-applications-list');
  const storesList = document.getElementById('search-stores-list');
  const productsList = document.getElementById('search-list');

  if (!q) {
    appsHeading.hidden = true;
    storesHeading.hidden = true;
    productsHeading.hidden = true;
    appsList.innerHTML = '';
    storesList.innerHTML = '';
    productsList.innerHTML = '';
    return;
  }

  showLoading('Searching…');
  try {
    const [appsResult, storesResult, productsResult] = await Promise.all([
      client.from('admin_pending_applications').select('*').ilike('business_name', `%${q}%`).limit(10),
      client.from('admin_seller_overview').select('*').ilike('store_name', `%${q}%`).limit(10),
      client.from('products').select('id, title, moderation_status').ilike('title', `%${q}%`).limit(20),
    ]);

    appsList.innerHTML = '';
    if (appsResult.error) {
      showToast(appsResult.error.message, true);
    } else {
      appsHeading.hidden = appsResult.data.length === 0;
      appsResult.data.forEach((app) => appsList.appendChild(applicationCard(app)));
    }

    storesList.innerHTML = '';
    if (storesResult.error) {
      showToast(storesResult.error.message, true);
    } else {
      storesHeading.hidden = storesResult.data.length === 0;
      storesResult.data.forEach((s) => storesList.appendChild(sellerCard(s)));
    }

    productsList.innerHTML = '';
    if (productsResult.error) {
      showToast(productsResult.error.message, true);
    } else {
      productsHeading.hidden = productsResult.data.length === 0;
      productsResult.data.forEach((p) => productsList.appendChild(productSearchCard(p)));
    }

    if (
      !appsResult.error && !storesResult.error && !productsResult.error &&
      appsResult.data.length === 0 && storesResult.data.length === 0 && productsResult.data.length === 0
    ) {
      productsList.innerHTML = '<p class="empty-state">Nothing matched.</p>';
    }
  } finally {
    hideLoading();
  }
}

function initSearch() {
  document.getElementById('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    lastSearchQuery = document.getElementById('search-input').value;
    loadSearchResults();
  });
}

// --- Generic field modals (profile edit / create store / create listing) --
// Same promise-based, resolve-to-null-on-cancel contract as askForReason
// above, just reading from a fixed set of inputs per modal instead of
// one shared textarea.

function openFieldModal(overlayId, submitBtnId, cancelBtnId, collect) {
  const overlay = document.getElementById(overlayId);
  const submitBtn = document.getElementById(submitBtnId);
  const cancelBtn = document.getElementById(cancelBtnId);

  return new Promise((resolve) => {
    function cleanup(result) {
      overlay.classList.remove('visible');
      submitBtn.removeEventListener('click', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('mousedown', onOverlayClick);
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    }
    function onSubmit() { cleanup(collect()); }
    function onCancel() { cleanup(null); }
    function onOverlayClick(e) { if (e.target === overlay) cleanup(null); }
    function onKeydown(e) { if (e.key === 'Escape') cleanup(null); }

    submitBtn.addEventListener('click', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('mousedown', onOverlayClick);
    document.addEventListener('keydown', onKeydown);

    overlay.classList.add('visible');
  });
}

// --- Photo pickers ----------------------------------------------------
// Every superuser form with a photo (profile avatar, store logo, listing
// photos) shares this: a hidden <input type=file>, a preview area of
// thumbnails, and a button that opens the file picker. Each entry is
// either a freshly-picked File (not uploaded yet) or a pre-existing URL
// (when editing something that already has a photo and it wasn't
// touched) — resolvePhotoUrls() below turns a picker's current entries
// into final uploaded URLs right before the calling function writes to
// the DB, so nothing is uploaded until the form is actually submitted.
function createPhotoPicker({ inputId, previewId, btnId, multi = false }) {
  const input = document.getElementById(inputId);
  const preview = document.getElementById(previewId);
  const btn = document.getElementById(btnId);
  let entries = []; // { file: File|null, previewUrl: string, existingUrl?: string }

  function render() {
    preview.innerHTML = '';
    entries.forEach((entry, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'photo-thumb';
      thumb.innerHTML = `<img src="${entry.previewUrl}" alt="" /><span class="photo-thumb-remove" data-i="${i}">&times;</span>`;
      thumb.querySelector('.photo-thumb-remove').addEventListener('click', () => {
        entries.splice(i, 1);
        render();
      });
      preview.appendChild(thumb);
    });
  }

  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const picked = Array.from(input.files || []);
    if (!multi) entries = [];
    picked.forEach((file) => entries.push({ file, previewUrl: URL.createObjectURL(file) }));
    input.value = '';
    render();
  });

  return {
    // existingUrl(s): a single URL string, an array of URLs, or null/undefined for empty.
    reset(existingUrls) {
      const urls = existingUrls == null ? [] : (Array.isArray(existingUrls) ? existingUrls : [existingUrls]);
      entries = urls.filter(Boolean).map((url) => ({ file: null, previewUrl: url, existingUrl: url }));
      render();
    },
    getEntries() { return entries; },
  };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

async function uploadImageFile(file) {
  const imageBase64 = await fileToBase64(file);
  const filename = `${Date.now()}_${(file.name || 'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const { publicUrl } = await callFunction('upload-product-image', { imageBase64, filename });
  return publicUrl;
}

// Turns a picker's current entries into an ordered array of final URLs,
// uploading any freshly-picked files (existing ones are kept as-is).
async function resolvePhotoUrls(picker) {
  const urls = [];
  for (const entry of picker.getEntries()) {
    urls.push(entry.file ? await uploadImageFile(entry.file) : entry.existingUrl);
  }
  return urls;
}

let profileEditPhotoPicker;
let storeFormPhotoPicker;
let createListingPhotoPicker;

function initPhotoPickers() {
  profileEditPhotoPicker = createPhotoPicker({
    inputId: 'profile-edit-photo-input',
    previewId: 'profile-edit-photo-preview',
    btnId: 'profile-edit-photo-btn',
    multi: false,
  });
  storeFormPhotoPicker = createPhotoPicker({
    inputId: 'store-form-photo-input',
    previewId: 'store-form-photo-preview',
    btnId: 'store-form-photo-btn',
    multi: false,
  });
  createListingPhotoPicker = createPhotoPicker({
    inputId: 'create-listing-photo-input',
    previewId: 'create-listing-photo-preview',
    btnId: 'create-listing-photo-btn',
    multi: true,
  });
}

// --- Field modals -------------------------------------------------------

function openProfileEditModal(profile) {
  document.getElementById('profile-edit-first-name').value = profile.first_name || '';
  document.getElementById('profile-edit-last-name').value = profile.last_name || '';
  document.getElementById('profile-edit-email').value = profile.email || '';
  document.getElementById('profile-edit-phone').value = profile.phone || '';
  profileEditPhotoPicker.reset(profile.avatar_url);
  return openFieldModal('profile-edit-overlay', 'profile-edit-submit', 'profile-edit-cancel', () => ({
    first_name: document.getElementById('profile-edit-first-name').value.trim(),
    last_name: document.getElementById('profile-edit-last-name').value.trim(),
    email: document.getElementById('profile-edit-email').value.trim(),
    phone: document.getElementById('profile-edit-phone').value.trim(),
  }));
}

// Shared by "Create a store for user" (Superuser tools) and "Edit store"
// (Store detail) — same fields either way, just pre-filled or blank and
// relabelled. `store` is the full stores row for edit, or null to create.
function openStoreFormModal(mode, store) {
  document.getElementById('store-form-title').textContent = mode === 'edit' ? 'Edit store' : 'Create a store';
  document.getElementById('store-form-submit').textContent = mode === 'edit' ? 'Save' : 'Create';

  document.getElementById('store-form-name').value = store?.name || '';
  document.getElementById('store-form-type').value = store?.store_type || 'restaurant';
  document.getElementById('store-form-description').value = store?.description || '';
  document.getElementById('store-form-address').value = store?.address || '';
  document.getElementById('store-form-landmark').value = store?.landmark || '';
  document.getElementById('store-form-city').value = store?.city || '';
  document.getElementById('store-form-state').value = store?.state || '';
  document.getElementById('store-form-postal-code').value = store?.postal_code || '';
  document.getElementById('store-form-cuisine').value = store?.cuisine || '';
  document.getElementById('store-form-price-tier').value = store?.price_tier != null ? String(store.price_tier) : '';
  document.getElementById('store-form-delivery-fee').value = store?.delivery_fee ?? '';
  document.getElementById('store-form-prep-min').value = store?.prep_time_min_minutes ?? '';
  document.getElementById('store-form-prep-max').value = store?.prep_time_max_minutes ?? '';
  document.getElementById('store-form-verified').checked = !!store?.is_verified;
  storeFormPhotoPicker.reset(store?.image_url || null);

  return openFieldModal('store-form-overlay', 'store-form-submit', 'store-form-cancel', () => {
    const priceTier = document.getElementById('store-form-price-tier').value;
    const deliveryFee = document.getElementById('store-form-delivery-fee').value;
    const prepMin = document.getElementById('store-form-prep-min').value;
    const prepMax = document.getElementById('store-form-prep-max').value;
    return {
      name: document.getElementById('store-form-name').value.trim(),
      store_type: document.getElementById('store-form-type').value,
      description: document.getElementById('store-form-description').value.trim() || null,
      address: document.getElementById('store-form-address').value.trim() || null,
      landmark: document.getElementById('store-form-landmark').value.trim() || null,
      city: document.getElementById('store-form-city').value.trim() || null,
      state: document.getElementById('store-form-state').value.trim() || null,
      postal_code: document.getElementById('store-form-postal-code').value.trim() || null,
      cuisine: document.getElementById('store-form-cuisine').value.trim() || null,
      price_tier: priceTier ? Number(priceTier) : null,
      delivery_fee: deliveryFee ? Number(deliveryFee) : null,
      prep_time_min_minutes: prepMin ? Number(prepMin) : null,
      prep_time_max_minutes: prepMax ? Number(prepMax) : null,
      is_verified: document.getElementById('store-form-verified').checked,
    };
  });
}

// Shared by "Add listing" (Store detail, create mode) and "Edit listing"
// (per-product, edit mode) -- same fields either way, just pre-filled or
// blank and relabelled. `product` is the full products row for edit, or
// null to create. Mirrors openStoreFormModal()'s create/edit pattern.
function openListingFormModal(mode, product) {
  document.getElementById('create-listing-title').textContent = mode === 'edit' ? 'Edit listing' : 'Add a listing';
  document.getElementById('create-listing-submit').textContent = mode === 'edit' ? 'Save' : 'Create';

  document.getElementById('create-listing-name').value = product?.title || '';
  document.getElementById('create-listing-description').value = product?.description || '';
  document.getElementById('create-listing-price').value = product?.price ?? '';
  document.getElementById('create-listing-category').value = product?.category || '';
  document.getElementById('create-listing-stock').value = product?.stock ?? '0';
  document.getElementById('create-listing-pickup-address').value = product?.pickup_address || '';
  document.getElementById('create-listing-pickup-landmark').value = product?.pickup_landmark || '';
  createListingPhotoPicker.reset(product?.image_urls || null);

  return openFieldModal('create-listing-overlay', 'create-listing-submit', 'create-listing-cancel', () => ({
    title: document.getElementById('create-listing-name').value.trim(),
    description: document.getElementById('create-listing-description').value.trim() || null,
    price: parseFloat(document.getElementById('create-listing-price').value),
    category: document.getElementById('create-listing-category').value.trim() || null,
    stock: parseInt(document.getElementById('create-listing-stock').value, 10) || 0,
    pickup_address: document.getElementById('create-listing-pickup-address').value.trim() || null,
    pickup_landmark: document.getElementById('create-listing-pickup-landmark').value.trim() || null,
  }));
}

// Shared by the store detail "Edit owner profile" button and Superuser
// tools' user lookup -- both just need a profile id to edit. This is the
// PERSON's own profile (first/last name, email, phone, avatar) — see
// editStore() below for the store/merchant's own business profile.
async function editProfile(profileId) {
  const { data: profile, error: fetchError } = await client
    .from('profiles')
    .select('first_name, last_name, email, phone, avatar_url')
    .eq('id', profileId)
    .single();
  if (fetchError) return showToast(fetchError.message, true);

  const fields = await openProfileEditModal(profile);
  if (!fields) return;
  if (!fields.first_name) return showToast('Enter a first name.', true);

  showLoading('Saving profile…');
  try {
    const avatarUrls = await resolvePhotoUrls(profileEditPhotoPicker);
    const { error } = await client
      .from('profiles')
      .update({ ...fields, avatar_url: avatarUrls[0] || null })
      .eq('id', profileId);
    if (error) return showToast(error.message, true);
    showToast('Profile updated.');
    if (currentStoreDetail) loadSellers(true);
  } catch (e) {
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

async function createStoreForUser(ownerId) {
  const fields = await openStoreFormModal('create', null);
  if (!fields) return;
  if (!fields.name) return showToast('Enter a store name.', true);

  showLoading('Creating store…');
  try {
    const logoUrls = await resolvePhotoUrls(storeFormPhotoPicker);
    const { error } = await client.from('stores').insert({
      owner_id: ownerId,
      image_url: logoUrls[0] || null,
      is_active: true,
      ...fields,
    });
    if (error) return showToast(error.message, true);
    showToast('Store created.');
    loadSellers(true);
    loadOverview();
  } catch (e) {
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

// This is the STORE's own business profile — name, logo, description,
// address, cuisine/price-tier/prep-time/delivery-fee display attributes,
// and the Verified badge (migration 0046 flagged is_verified as "not
// seller-editable... follow-up if verification needs to be admin-gated" —
// this is that follow-up). See editProfile() above for the owner's own
// personal profile.
async function editStore(storeOverview) {
  const { data: store, error: fetchError } = await client
    .from('stores')
    .select('*')
    .eq('id', storeOverview.store_id)
    .single();
  if (fetchError) return showToast(fetchError.message, true);

  const fields = await openStoreFormModal('edit', store);
  if (!fields) return;
  if (!fields.name) return showToast('Enter a store name.', true);

  showLoading('Saving store…');
  try {
    const logoUrls = await resolvePhotoUrls(storeFormPhotoPicker);
    const { error } = await client
      .from('stores')
      .update({ ...fields, image_url: logoUrls[0] || null })
      .eq('id', store.id);
    if (error) return showToast(error.message, true);
    showToast('Store updated.');
    document.getElementById('store-detail-title').textContent = fields.name;
    loadSellers(true);
  } catch (e) {
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

async function createListingForStore(store) {
  const fields = await openListingFormModal('create', null);
  if (!fields) return;
  if (!fields.title || !fields.category || !(fields.price >= 0)) {
    return showToast('Enter a title, category, and a valid price.', true);
  }

  showLoading('Creating listing…');
  try {
    const imageUrls = await resolvePhotoUrls(createListingPhotoPicker);
    const { error } = await client.from('products').insert({
      seller_id: store.owner_id,
      store_id: store.store_id,
      image_urls: imageUrls,
      ...fields,
    });
    if (error) return showToast(error.message, true);
    showToast('Listing created.');
    viewStoreDetail(store);
  } catch (e) {
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

// Edits a listing in ANY store (unlike a seller's own edit path in the
// app, which is scoped to their own products) -- backed by "Superusers
// can update any product" (migration 0075). Fetches the full row first
// since storeProductCard()'s list query only selects the fields that
// list view needs.
async function editListing(product) {
  const { data: fullProduct, error: fetchError } = await client
    .from('products')
    .select('*')
    .eq('id', product.id)
    .single();
  if (fetchError) return showToast(fetchError.message, true);

  const fields = await openListingFormModal('edit', fullProduct);
  if (!fields) return;
  if (!fields.title || !fields.category || !(fields.price >= 0)) {
    return showToast('Enter a title, category, and a valid price.', true);
  }

  showLoading('Saving listing…');
  try {
    const imageUrls = await resolvePhotoUrls(createListingPhotoPicker);
    const { data, error } = await client
      .from('products')
      .update({ image_urls: imageUrls, ...fields })
      .eq('id', fullProduct.id)
      .select('id');
    if (error) return showToast(error.message, true);
    if (!data || data.length === 0) {
      return showToast("Couldn't save — you may not have permission to edit this listing.", true);
    }
    showToast('Listing updated.');
    if (currentStoreDetail) viewStoreDetail(currentStoreDetail);
  } catch (e) {
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

// --- Superuser tools: look up any account by phone ------------------------

function userLookupResultCard(profile) {
  const card = document.createElement('div');
  card.className = 'card';
  const name = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || profile.full_name || 'Unnamed';
  card.innerHTML = `
    <div class="card-title-row">
      <div>
        <p class="card-title">${escapeHtml(name)}</p>
        <p class="card-subtitle">${escapeHtml(profile.email || '')} · ${escapeHtml(profile.phone || '')}</p>
      </div>
    </div>
    <div class="card-actions">
      <button class="btn-secondary" data-action="edit">Edit profile</button>
      <button class="btn-primary" data-action="create-store">Create a store for this user</button>
      <button class="btn-danger" data-action="delete">Delete account</button>
    </div>
  `;
  card.querySelector('[data-action="edit"]').addEventListener('click', () => editProfile(profile.id));
  card.querySelector('[data-action="create-store"]').addEventListener('click', () => createStoreForUser(profile.id));
  card.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    const confirmed = window.confirm(
      `Delete ${name}'s account?\n\nThis permanently scrubs their personal data and blocks them from logging in. This cannot be undone.`,
    );
    if (!confirmed) return;
    showLoading('Deleting account…');
    try {
      await callFunction('admin-delete-user', { targetUserId: profile.id });
      showToast('Account deleted.');
      document.getElementById('user-lookup-result').innerHTML = '';
    } catch (e) {
      showToast(e.message, true);
    } finally {
      hideLoading();
    }
  });
  return card;
}

function initSuperuserTools() {
  initPhotoPickers();

  document.getElementById('store-detail-edit-profile').addEventListener('click', () => {
    if (currentStoreDetail) editProfile(currentStoreDetail.owner_id);
  });
  document.getElementById('store-detail-edit-store').addEventListener('click', () => {
    if (currentStoreDetail) editStore(currentStoreDetail);
  });
  document.getElementById('store-detail-add-listing').addEventListener('click', () => {
    if (currentStoreDetail) createListingForStore(currentStoreDetail);
  });

  document.getElementById('user-lookup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    assertPanelAccess('superuser');
    const input = document.getElementById('user-lookup-input');
    const phone = input.value.trim();
    if (!phone) return;
    const resultEl = document.getElementById('user-lookup-result');
    resultEl.innerHTML = '';

    showLoading('Looking up account…');
    try {
      const { data: userId, error: lookupError } = await client.rpc('find_profile_id_by_phone', { p_phone: phone });
      if (lookupError) return showToast(lookupError.message, true);
      if (!userId) return showToast(`No app account found with phone ${phone}.`, true);

      const { data: profile, error } = await client.from('profiles').select('*').eq('id', userId).single();
      if (error) return showToast(error.message, true);
      resultEl.appendChild(userLookupResultCard(profile));
    } finally {
      hideLoading();
    }
  });
}

// --- Role-based visibility --------------------------------------------
// Support (Customer Experience) can see everything EXCEPT Applications
// and Superuser tools. Merchant (Merchant Success) can see everything
// EXCEPT Flagged products, User reports, User messages, and Superuser
// tools. Superuser sees and can do everything. "Sellers & stores" isn't
// restricted for either role.
//
// Search is the one exception worth calling out: it surfaces pending
// applications alongside stores/products (see loadSearchResults()), so
// giving Support the Search panel would leak the exact Applications
// data they're not supposed to see. It's kept Merchant/Superuser-only
// for that reason, even though "Search" itself isn't named on either
// restricted list.
//
// Actions that are ALSO narrower than "any admin" within a panel both
// roles can see (e.g. only a superuser can deactivate a store or edit
// a listing) are gated individually where they're rendered —
// sellerCard(), storeProductCard(), viewStoreDetail() above.
// Four roles actually exist in the `admins` table: 'customer_experience'
// (Support), 'merchant_success' (Merchant), 'fleet_ops' (reviews rider
// applications — migration 0072_rider_applications.sql), and
// 'superuser'. I previously "fixed" riders to use merchant_success,
// thinking fleet_ops was a typo/dead role — it isn't. It's a real,
// deliberately separate role (its own is_fleet_ops() DB function,
// its own RLS policies) for the team that reviews riders, distinct
// from Merchant Success. Reverted.
const PANEL_ROLE_ACCESS = {
  applications: ['merchant_success', 'superuser'],
  riders: ['fleet_ops', 'superuser'],
  flagged: ['customer_experience', 'superuser'],
  reports: ['customer_experience', 'superuser'],
  messages: ['customer_experience', 'superuser'],
  search: ['merchant_success', 'superuser'],
  superuser: ['superuser'],
  // 'sellers' intentionally has no entry: every role can see it.
};

const ROLE_LABELS = {
  customer_experience: 'Customer Experience',
  merchant_success: 'Merchant Success',
  fleet_ops: 'Fleet Ops',
  superuser: 'Superuser',
};

// Single source of truth for "can this role see this panel" — used both
// to hide nav/stat-card buttons and to decide which data to load, so the
// two can never drift apart (e.g. a panel that's hidden but still fetched).
function canAccessPanel(panel, role) {
  const allowed = PANEL_ROLE_ACCESS[panel];
  return !allowed || allowed.includes(role);
}

// Defense-in-depth: called at the top of every panel's data-loading
// function so that even a direct call from the console (bypassing the
// hidden nav button) refuses to run for a role that shouldn't see that
// panel. This is a UI-layer safety net only — it stops someone from
// tricking THIS PAGE into rendering data it already fetched or could
// fetch, but it can't stop someone from querying Supabase directly with
// their own valid session and the public anon key. That boundary has to
// be enforced server-side with Supabase RLS policies on the underlying
// tables/views, keyed off admins.role — this function does not replace
// that.
function assertPanelAccess(panel) {
  if (!canAccessPanel(panel, getAdminRole())) {
    throw new Error(`Blocked: role "${getAdminRole()}" is not permitted to access "${panel}".`);
  }
}

function applyRoleVisibility(role) {
  document.querySelectorAll('.nav-link[data-panel]').forEach((btn) => {
    if (!canAccessPanel(btn.dataset.panel, role)) btn.hidden = true;
  });
  document.querySelectorAll('.stat-card[data-panel]').forEach((btn) => {
    if (!canAccessPanel(btn.dataset.panel, role)) btn.hidden = true;
  });

  const badge = document.getElementById('role-badge');
  badge.textContent = ROLE_LABELS[role] || role;
  badge.hidden = false;
}

// --- Boot -----------------------------------------------------------------

async function boot() {
  showLoading('Loading dashboard…');
  try {
    SESSION = await requireAdminSession();
    if (!SESSION) return; // requireAdminSession already redirected

    const role = getAdminRole();
    applyRoleVisibility(role);

    initNav();
    initStatCards();
    initListControls();
    initSearch();
    initMessages();
    initSuperuserTools();

    if (canAccessPanel('messages', role)) {
      const { data: supportId } = await client.rpc('get_support_account_id');
      SUPPORT_ACCOUNT_ID = supportId;
    }

    const loaders = [loadOverview(), loadSellers()]; // sellers isn't role-restricted
    if (canAccessPanel('applications', role)) loaders.push(loadApplications());
    if (canAccessPanel('riders', role)) loaders.push(loadRiderApplications());
    if (canAccessPanel('flagged', role)) loaders.push(loadFlagged());
    if (canAccessPanel('reports', role)) loaders.push(loadUserReports());
    if (canAccessPanel('messages', role)) loaders.push(loadUserMessages());
    await Promise.all(loaders);
  } finally {
    hideLoading();
  }
}

boot();