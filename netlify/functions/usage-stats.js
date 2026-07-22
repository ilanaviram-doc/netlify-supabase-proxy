// netlify/functions/usage-stats.js
// -----------------------------------------------------------------------------
// Live service-usage proxy for the ClinikAI admin panel.
// Keys live ONLY here as Netlify env vars; the browser never sees them, and this
// function handles CORS by calling each provider server-to-server.
//
// Env vars (Netlify -> Site settings -> Environment variables):
//   ANTHROPIC_ADMIN_KEY / ANTHROPIC_API_KEY   Anthropic key (Admin key needed for costs)
//   OPENAI_ADMIN_KEY / OPENAI_API_KEY         OpenAI key (Admin key needed for costs)
//   VOICEFLOW_API_KEY                         Voiceflow API key (workspace-level)
//   VOICEFLOW_PROJECT_IDS                     comma-separated list of ALL project IDs
//   RESEND_API_KEY                            Resend key
//   SUPABASE_URL + SUPABASE_ANON_KEY          used to validate the caller
//   *_ORG_LIMIT_USD / *_LIMIT / VOICEFLOW_CREDIT_LIMIT / RESEND_MONTHLY_LIMIT  (optional)
// -----------------------------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

function monthStartISO() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
function num(v) { const n = Number(String(v == null ? '' : v).replace(/[,\s]/g, '')); return isNaN(n) ? 0 : n; }

// Read the first defined env var from a list of possible names.
function envAny(names) {
  for (const n of names) { const v = process.env[n]; if (v && String(v).trim()) return v; }
  return '';
}
// Friendly error text — 401/403 on the cost APIs almost always means a non-Admin key.
function httpErr(status) {
  return (status === 401 || status === 403)
    ? 'מפתח לא מורשה (' + status + ') — צריך Admin key'
    : 'HTTP ' + status;
}
// A fetch that can't hang forever.
function fetchT(url, opts, ms) {
  return fetch(url, { ...(opts || {}), signal: AbortSignal.timeout(ms || 7000) });
}
// Guarantee a provider can never hang the whole function: race it against a
// timeout that resolves to a safe fallback so the panel still gets a response.
function withTimeout(promise, ms, key) {
  return Promise.race([
    Promise.resolve(promise).catch(e => ({ key, status: 'error', error: String((e && e.message) || e) })),
    new Promise(res => setTimeout(() => res({ key, status: 'error', error: 'timeout' }), ms))
  ]);
}

// --- Validate the caller is a logged-in admin (Supabase JWT) -----------------
async function callerIsValid(auth) {
  try {
    const url = process.env.SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY;
    if (!url || !anon || !auth) return false;
    const r = await fetchT(`${url}/auth/v1/user`, { headers: { apikey: anon, Authorization: auth } }, 6000);
    return r.ok;
  } catch { return false; }
}

// --- Anthropic: month-to-date cost (Admin Cost Report) -----------------------
async function getAnthropic() {
  const key = envAny(['ANTHROPIC_ADMIN_KEY', 'ANTHROPIC_API_KEY']);
  // Individual (non-Organization) accounts can't create an Admin key, so the cost
  // API is unreachable — fall back to a shortcut card to the console usage page.
  const consoleUrl = process.env.ANTHROPIC_USAGE_URL || 'https://platform.claude.com/dashboard';
  const linkCard = (note) => ({ key: 'anthropic', status: 'link', url: consoleUrl,
                                linkLabel: 'צפה בעלות ב-Anthropic', note });
  if (!key) return linkCard('דרוש Admin key לנתון חי');
  try {
    const u = new URL('https://api.anthropic.com/v1/organizations/cost_report');
    u.searchParams.set('starting_at', monthStartISO());
    u.searchParams.set('bucket_width', '1d');
    const r = await fetchT(u, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }, 7000);
    if (r.status === 401 || r.status === 403) return linkCard('דרוש Admin key לנתון חי');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    let usd = 0;
    (j.data || []).forEach(bucket => (bucket.results || []).forEach(res => {
      const a = res.amount;
      usd += typeof a === 'object' && a !== null ? num(a.value) : num(a ?? res.cost);
    }));
    const limit = process.env.ANTHROPIC_ORG_LIMIT_USD ? num(process.env.ANTHROPIC_ORG_LIMIT_USD) : null;
    return { key: 'anthropic', status: 'ok', unit: 'usd', consumed: Math.round(usd * 100) / 100,
             limit, periodLabel: 'עלות מתחילת החודש', note: 'דוחות פרופיל ותמות טיפוליות' };
  } catch (e) { return { key: 'anthropic', status: 'error', error: e.message }; }
}

// --- OpenAI: month-to-date cost (Admin Costs API) ----------------------------
async function getOpenAI() {
  const key = envAny(['OPENAI_ADMIN_KEY', 'OPENAI_API_KEY']);
  if (!key) return { key: 'openai', status: 'not-configured' };
  try {
    const start = Math.floor(new Date(monthStartISO()).getTime() / 1000);
    const u = new URL('https://api.openai.com/v1/organization/costs');
    u.searchParams.set('start_time', String(start));
    u.searchParams.set('limit', '31'); // month-to-date daily buckets — smaller = faster
    const r = await fetchT(u, { headers: { Authorization: `Bearer ${key}` } }, 9000);
    if (!r.ok) throw new Error(httpErr(r.status));
    const j = await r.json();
    let usd = 0;
    (j.data || []).forEach(bucket => (bucket.results || []).forEach(res => {
      const a = res.amount;
      usd += typeof a === 'object' && a !== null ? num(a.value) : num(a);
    }));
    const limit = process.env.OPENAI_ORG_LIMIT_USD ? num(process.env.OPENAI_ORG_LIMIT_USD) : null;
    return { key: 'openai', status: 'ok', unit: 'usd', consumed: Math.round(usd * 100) / 100,
             limit, periodLabel: 'עלות מתחילת החודש', note: 'תמלול קולי (STT/VTT)' };
  } catch (e) { return { key: 'openai', status: 'error', error: e.message }; }
}

// --- Voiceflow: WORKSPACE credit usage this month (sum across all projects) ---
// Voiceflow exposes credit usage ONLY per-project, so we sum credit_usage over
// --- Voiceflow: shortcut card to the Billing page ----------------------------
// Voiceflow's API has NO dollar/cost metric (only credits, and only per single
// project), so a live $ figure isn't possible. We link straight to the Billing
// page where the real $ is shown. Override the URL with VOICEFLOW_BILLING_URL.
async function getVoiceflow() {
  const url = process.env.VOICEFLOW_BILLING_URL || 'https://creator.voiceflow.com/workspace/VzElM4eVkL/projects';
  return { key: 'voiceflow', status: 'link', url, linkLabel: 'צפה בעלות ב-Voiceflow',
           note: 'עלות $ זמינה רק בדשבורד של Voiceflow' };
}

// --- Resend: emails sent this month ------------------------------------------
async function getResend() {
  const key = envAny(['RESEND_API_KEY', 'RESEND_KEY']);
  if (!key) return { key: 'resend', status: 'not-configured' };
  try {
    const r = await fetchT('https://api.resend.com/emails', { headers: { Authorization: `Bearer ${key}` } }, 7000);
    if (!r.ok) throw new Error(httpErr(r.status));
    const j = await r.json();
    const list = j.data || j.emails || [];
    const start = new Date(monthStartISO()).getTime();
    const consumed = list.filter(e => new Date(e.created_at || e.created || 0).getTime() >= start).length;
    const limit = process.env.RESEND_MONTHLY_LIMIT ? num(process.env.RESEND_MONTHLY_LIMIT) : null;
    return { key: 'resend', status: 'ok', unit: 'emails', consumed, limit,
             periodLabel: 'מיילים שנשלחו החודש',
             note: list.length >= 100 ? 'נספרו 100 המיילים האחרונים בלבד' : undefined };
  } catch (e) { return { key: 'resend', status: 'error', error: e.message }; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const auth = event.headers.authorization || event.headers.Authorization;

  // Run the auth check CONCURRENTLY with the provider calls, so the slow OpenAI
  // cost API gets the full time budget within Netlify's function limit rather
  // than auth-time + provider-time stacking up and tripping a platform timeout.
  const authP = callerIsValid(auth);
  const servicesP = Promise.all([
    withTimeout(getVoiceflow(), 9500, 'voiceflow'),
    withTimeout(getOpenAI(),    9500, 'openai'),
    withTimeout(getAnthropic(), 9500, 'anthropic'),
    withTimeout(getResend(),    8000, 'resend')
  ]);

  if (!(await authP)) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'unauthorized' }) };
  }
  const services = await servicesP;

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ updatedAt: new Date().toISOString(), services })
  };
};
