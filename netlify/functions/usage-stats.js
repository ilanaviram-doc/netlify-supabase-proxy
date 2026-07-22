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
function num(v) { const n = Number(v); return isNaN(n) ? 0 : n; }

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
  if (!key) return { key: 'anthropic', status: 'not-configured' };
  try {
    const u = new URL('https://api.anthropic.com/v1/organizations/cost_report');
    u.searchParams.set('starting_at', monthStartISO());
    u.searchParams.set('bucket_width', '1d');
    const r = await fetchT(u, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }, 7000);
    if (!r.ok) throw new Error(httpErr(r.status));
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
    u.searchParams.set('limit', '180');
    const r = await fetchT(u, { headers: { Authorization: `Bearer ${key}` } }, 7000);
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
// every project ID. Endpoint: POST https://analytics-api.voiceflow.com/v2/query/usage
async function getVoiceflow() {
  const key = envAny(['VOICEFLOW_API_KEY', 'VF_API_KEY', 'VOICEFLOW_DM_API_KEY']);
  const idsRaw = envAny(['VOICEFLOW_PROJECT_IDS', 'VOICEFLOW_PROJECT_ID', 'VF_PROJECT_ID']);
  if (!key || !idsRaw) return { key: 'voiceflow', status: 'not-configured' };

  const ids = idsRaw.split(',').map(s => s.trim()).filter(Boolean);
  const startTime = monthStartISO();
  const endTime = new Date().toISOString();

  async function projectCredits(projectID) {
    let total = 0, cursor, pages = 0;
    do {
      const filter = { projectID, startTime, endTime, limit: 500 };
      if (cursor) filter.cursor = cursor;
      const r = await fetchT('https://analytics-api.voiceflow.com/v2/query/usage', {
        method: 'POST',
        headers: { authorization: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { name: 'credit_usage', filter } })
      }, 6000);
      if (!r.ok) throw new Error(httpErr(r.status));
      const j = await r.json();
      const items = j.items || j.data || [];
      items.forEach(it => { total += num(it.count ?? it.value); });
      cursor = (items.length >= 500 && j.cursor) ? j.cursor : undefined;
      pages++;
    } while (cursor && pages < 25);
    return total;
  }

  try {
    // A failure on one project must not zero the whole card — swallow to 0.
    const per = await Promise.all(ids.map(id => projectCredits(id).catch(() => 0)));
    const consumed = per.reduce((a, b) => a + b, 0);
    const limit = envAny(['VOICEFLOW_CREDIT_LIMIT']) ? num(envAny(['VOICEFLOW_CREDIT_LIMIT'])) : null;
    return { key: 'voiceflow', status: 'ok', unit: 'credits', consumed, limit,
             periodLabel: 'קרדיטים מתחילת החודש (כל הפרויקטים)', note: ids.length + ' פרויקטים' };
  } catch (e) { return { key: 'voiceflow', status: 'error', error: e.message }; }
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
  if (!(await callerIsValid(auth))) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  // Each provider is time-boxed so a slow one (e.g. Voiceflow's many projects)
  // can never make the whole function time out and break the other cards.
  const services = await Promise.all([
    withTimeout(getVoiceflow(), 8500, 'voiceflow'),
    withTimeout(getOpenAI(),    7500, 'openai'),
    withTimeout(getAnthropic(), 7500, 'anthropic'),
    withTimeout(getResend(),    7500, 'resend')
  ]);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ updatedAt: new Date().toISOString(), services })
  };
};
