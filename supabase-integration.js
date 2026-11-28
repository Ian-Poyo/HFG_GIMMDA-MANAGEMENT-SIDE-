/* GIMMDA dashboard · shared Supabase data layer
   Public configuration only. All permission checks happen in the database. */
const SUPABASE_URL = 'https://jsfrbgeliyfijinmxvmi.supabase.co';
// Cloudflare Turnstile Site Key (live production key for hfg-management-side.vercel.app; ensure Secret Key is saved in Supabase Auth -> Bot & Abuse Protection).
const TURNSTILE_SITE_KEY = '0x4AAAAAAGUdL9c2mvJEqUyf';
const SUPABASE_KEY = 'sb_publishable_GsyE4fCJRec6y1od2KACEw_A2zAWUOr';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const live = {
  ready: false,
  session: null,
  profile: null,
  members: [],
  plans: [],
  inventory: [],
  payments: [],
  visits: [],
  sales: [],
  movements: [],
  walkins: [],
  activity: [],
  requests: [],
  approvals: [],
  team: [],
  settings: null,
  shifts: [],
  expenses: [],
  broadcasts: [],
  feedback: [],
  activityKinds: [],
  summary: null,
  period: 'month',
  customFrom: null,
  customTo: null,
  lastSync: null
};

const PH_TZ = 'Asia/Manila';
const planLabel = months => (months === 12 ? '1 year' : `${months} month${months === 1 ? '' : 's'}`);
const peso = value => '₱' + Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const phToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: PH_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const phDateTime = value => value ? new Date(value).toLocaleString('en-PH', { timeZone: PH_TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : '—';
const chTime = value => value ? new Date(value).toLocaleTimeString('en-PH', { timeZone: PH_TZ, hour: 'numeric', minute: '2-digit', hour12: true }) : '—';
// A plain date (YYYY-MM-DD) must render as that same calendar day for everyone.
// Parsing it as Manila midnight and formatting in the viewer's zone shows the day before
// anywhere west of +08:00, so format it from the parts directly.
const fmtDay = value => {
  if (!value) return '—';
  // Only a *plain* date string is treated as a calendar day. A timestamp still needs
  // converting to Manila time, so match the whole value, not a prefix of it.
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return new Date(value).toLocaleDateString('en-PH', { timeZone: PH_TZ, month: 'short', day: 'numeric', year: 'numeric' });
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  return date.toLocaleDateString('en-PH', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
};
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dash = v => (v === null || v === undefined || v === '' ? '—' : v);
const initials = name => String(name || '?').split(' ').map(x => x[0]).slice(0, 2).join('').toUpperCase();

function friendly(error) {
  const map = {
    INVALID_CREDENTIALS: 'That email and password don’t match an account.',
    EMAIL_NOT_CONFIRMED: 'Please confirm your email address first.',
    NO_MEMBER_RECORD: 'This account isn’t linked to a member yet. Ask the front desk to add you.',
    MEMBERSHIP_INACTIVE: 'This membership is not active. Renew it before check-in.',
    MEMBERSHIP_EXPIRED: 'This membership has expired. Renew it before check-in.',
    ALREADY_CHECKED_IN: 'This member already has an open visit.',
    NOT_CHECKED_IN: 'There is no open visit for this member.',
    INSUFFICIENT_STOCK: 'Not enough stock for this sale.',
    INSUFFICIENT_CASH: 'Cash received is less than the total.',
    REFERENCE_REQUIRED: 'Enter the online payment reference.',
    REASON_REQUIRED: 'A reason is required.',
    FORBIDDEN: 'Your account doesn’t have permission for this action.',
    OWNER_EXISTS: 'An owner account already exists for this gym.',
    CANNOT_DEMOTE_SELF: 'You can’t remove your own owner access.',
    ALREADY_REVIEWED: 'This was already reviewed.',
    PRODUCT_NOT_FOUND: 'That product no longer exists.',
    MEMBER_NOT_FOUND: 'Member not found.',
    NAME_REQUIRED: 'Full name is required.',
    EMAIL_IN_USE: 'That email address is already used by another account.',
    EMAIL_INVALID: 'Enter a valid email address.',
    INVALID_ROLE: 'Choose either Owner or Staff for a team account.',
    CANNOT_DEACTIVATE_SELF: 'You can’t deactivate your own account.',
    PASSWORD_TOO_SHORT: 'Password must be at least 8 characters.',
    PERMISSION_DENIED: 'Your account doesn’t have permission for this action. Ask the owner.',
    ALREADY_REQUESTED: 'This request is already pending owner approval.'
  };
  const msg = String(error?.message || error || '');
  for (const key of Object.keys(map)) if (msg.includes(key)) return msg.includes('INSUFFICIENT_STOCK:') ? `Not enough stock for ${msg.split(':')[1]}.` : map[key];
  if (/invalid login credentials/i.test(msg)) return map.INVALID_CREDENTIALS;
  if (/email not confirmed/i.test(msg)) return map.EMAIL_NOT_CONFIRMED;
  if (/failed to fetch|network/i.test(msg)) return 'Can’t reach the gym service. Check your connection and try again.';
  return 'Something went wrong. No change was confirmed — please try again.';
}

async function call(fn, args, rpcName = fn) {
  const { data, error } = await sb.rpc(rpcName, args);
  if (error) throw error;
  return data;
}

/* The very first run: signing up from the setup form needs a short window. */
async function signUpFirstOwner(email, password, fullName) {
  const options = { data: { full_name: fullName } };
  const attemptOnce = async () => {
    const { data, error } = await sb.auth.signUp({ email, password, options });
    if (error) throw error;
    return data;
  };
  let attempt = { data: null, error: null };
  try { attempt.data = await attemptOnce(); } catch (error) { attempt.error = error; }
  if (attempt.error && /signups not allowed/i.test(attempt.error.message || '')) {
    const opened = await sb.rpc('first_run_open');
    if (opened.error) return attempt;
    try { attempt = { data: await attemptOnce(), error: null }; } catch (error) { attempt = { data: null, error }; }
    await sb.rpc('first_run_close');
  }
  return attempt;
}

async function loadAll() {
  const [members, plans, inventory, payments, visits, sales, movements, walkins, activity, requests, approvals, team, settings, summary, shifts, expensesAll, broadcasts, feedback, kinds] = await Promise.all([
    sb.from('member_directory').select('*').order('created_at', { ascending: false }),
    sb.from('membership_plans').select('*').order('months'),
    sb.from('inventory_items').select('*').order('name'),
    sb.from('payments').select('*').order('created_at', { ascending: false }).limit(60),
    sb.from('attendance_visits').select('*').order('checked_in_at', { ascending: false }).limit(60),
    sb.from('product_sales').select('*').order('created_at', { ascending: false }).limit(40),
    sb.from('stock_movements').select('*').order('created_at', { ascending: false }).limit(40),
    sb.from('walkins').select('*').order('created_at', { ascending: false }).limit(40),
    sb.from('activity_log').select('*').order('created_at', { ascending: false }).limit(80),
    sb.from('profile_change_requests').select('*').order('created_at', { ascending: false }).limit(40),
    sb.from('approval_requests').select('*').order('created_at', { ascending: false }).limit(60),
    sb.rpc('list_team'),
    sb.from('gym_settings').select('*').limit(1).maybeSingle(),
    window.ownerSummary(),
    sb.from('shifts').select('*').order('clocked_in_at', { ascending: false }).limit(40),
    sb.from('expenses').select('*').order('spent_on', { ascending: false }).limit(60),
    sb.from('broadcasts').select('*').order('created_at', { ascending: false }).limit(30),
    sb.from('feedback').select('*').order('created_at', { ascending: false }).limit(200),
    sb.rpc('activity_kinds')
  ]);
  for (const res of [members, plans, inventory, payments, visits, sales, movements, walkins, activity, requests, approvals, team, settings, summary, shifts, expensesAll, broadcasts, feedback, kinds]) {
    if (res?.error) console.warn('GIMMDA data', res.error);
  }
  live.members = members.data || [];
  live.plans = plans.data || [];
  live.inventory = inventory.data || [];
  live.payments = payments.data || [];
  live.visits = visits.data || [];
  live.sales = sales.data || [];
  live.movements = movements.data || [];
  live.walkins = walkins.data || [];
  live.activity = activity.data || [];
  live.requests = requests.data || [];
  live.approvals = approvals?.data || [];
  live.team = team.data || [];
  live.settings = settings.data || null;
  live.shifts = shifts?.data || [];
  live.expenses = expensesAll?.data || [];
  live.broadcasts = broadcasts?.data || [];
  live.feedback = feedback?.data || [];
  live.activityKinds = kinds?.data || [];
  live.summary = summary.data || summary || null;
  live.lastSync = new Date();
}

async function ownerSummary() {
  const range = periodRange();
  const { data, error } = await sb.rpc('owner_summary', { p_from: range.from, p_to: range.to });
  if (error) return { error };
  return data;
}
function todayRange() {
  const today = phToday();
  return { from: today, to: today };
}
function monthRange() {
  const today = phToday();
  return { from: today.slice(0, 8) + '01', to: today };
}
function yearRange() {
  const today = phToday();
  return { from: today.slice(0, 4) + '-01-01', to: today };
}
function lastMonthRange() {
  const [y, m] = phToday().split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 2, 1));
  const end = new Date(Date.UTC(y, m - 1, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}
function lastYearRange() {
  const y = Number(phToday().slice(0, 4)) - 1;
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}
function weekRange() {
  const now = new Date();
  const ph = new Date(now.toLocaleString('en-US', { timeZone: PH_TZ }));
  const monday = new Date(ph);
  monday.setDate(ph.getDate() - ((ph.getDay() + 6) % 7));
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: fmt(monday), to: phToday() };
}
function periodRange(p = live.period) {
  if (p === 'today') return todayRange();
  if (p === 'week') return weekRange();
  if (p === 'last_month') return lastMonthRange();
  if (p === 'year') return yearRange();
  if (p === 'last_year') return lastYearRange();
  if (p === 'custom' && live.customFrom && live.customTo) return { from: live.customFrom, to: live.customTo };
  return monthRange();
}

window.GIMMDA = { TURNSTILE_SITE_KEY, live, sb, call, loadAll, signUpFirstOwner, friendly, planLabel, peso, phToday, phDateTime, fmtDay, chTime, escHtml, dash, initials, ownerSummary, todayRange, monthRange, weekRange, yearRange, lastMonthRange, lastYearRange, periodRange };
