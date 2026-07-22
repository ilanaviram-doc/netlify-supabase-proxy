// netlify/functions/usage-stats.js
// -----------------------------------------------------------------------------
// Live service-usage proxy for the ClinikAI admin panel.
//
// Why a server-side proxy?
//   1. The provider keys (OpenAI / Anthropic / Voiceflow / Resend) must NEVER be
//      exposed in the browser. They live here as Netlify environment variables.
//   2. None of these provider APIs send CORS headers, so the browser cannot call
//      them directly. This function calls them server-to-server and returns one
//      normalized JSON payload the admin panel renders.
//
// Set these in Netlify  ->  Site settings  ->  Environment variables:
//   ANTHROPIC_ADMIN_KEY     Admin API key (starts with sk-ant-admin...)
//   OPENAI_ADMIN_KEY        Admin API key (starts with sk-admin...)
//   OPENAI_ORG_LIMIT_USD    (optional) your monthly budget in USD, to show "remaining"
//   ANTHROPIC_ORG_LIMIT_USD (optional) your monthly budget in USD
//   VOICEFLOW_API_KEY       Voiceflow API key — WORKSPACE-level (reads all projects)
//   VOICEFLOW_PROJECT_IDS   comma-separated list of ALL project IDs to sum
//   VOICEFLOW_CREDIT_LIMIT  (optional) monthly credit allowance from your plan
//   RESEND_API_KEY          Resend API key (re_xxxx)
//   RESEND_MONTHLY_LIMIT    (optional) monthly email allowance from your plan
//   SUPABASE_URL            https://rmgtegimphpjzxcflotn.supabase.co
//   SUPABASE_ANON_KEY       (public anon key) - used only to validate the caller
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

// --- Validate the caller is a logged-in admin (Supabase JWT) -----------------
async function callerIsValid(auth) {
  try {
    const url = process.env.SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY;
    if (!url || !anon || !auth) return false;
    const r = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: auth }
    });
    return r.ok;
  } catch { return false; }
}

// --- Anthropic: month-to-date cost (Admin Cost Report) -----------------------
// Docs: https://platform.claude.com/docs/en/api/admin/cost_report
async function getAnthropic() {
  const key = process.env.ANTHROPIC_ADMIN_KEY;
  if (!key) return { key: 'anthropic', status: 'not-configured' };
  try {
    const u = new URL('https://api.anthropic.com/v1/organizations/cost_report');
    u.searchParams.set('starting_at', monthStartISO());
    u.searchParams.set('bucket_width', '1d');
    const r = await fetch(u, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    let usd = 0;
    (j.data || []).forEach(bucket => (bucket.results || []).forEach(res => {
      // amount can be {value,currency} or a plain number depending on the field
      const a = res.amount;
      usd += typeof a === 'object' && a !== null ? num(a.value) : num(a ?? res.cost);
    }));
    const limit = process.env.ANTHROPIC_ORG_LIMIT_USD ? num(process.env.ANTHROPIC_ORG_LIMIT_USD) : null;
    return { key: 'anthropic', status: 'ok', unit: 'usd', consumed: Math.round(usd * 100) / 100,
             limit, periodLabel: 'עלות מתחילת החודש', note: 'דוחות פרופיל ותמות טיפוליות' };
  } catch (e) { return { key: 'anthropic', status: 'error', error: e.message }; }
}

// --- OpenAI: month-to-date cost (Admin Costs API) ----------------------------
// Docs: https://developers.openai.com/api/reference/.../organization/subresources/usage/methods/costs
async function getOpenAI() {
  const key = process.env.OPENAI_ADMIN_KEY;
  if (!key) return { key: 'openai', status: 'not-configured' };
  try {
    const start = Math.floor(new Date(monthStartISO()).getTime() / 1000);
    const u = new URL('https://api.openai.com/v1/organization/costs');
    u.searchParams.set('start_time', String(start));
    u.searchParams.set('limit', '180');
    const r = await fetch(u, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
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
// Voiceflow exposes credit usage ONLY per-project (no workspace endpoint), so we
// loop over every project ID and sum the `credit_usage` metric — that sum equals
// the workspace credit figure shown on the Voiceflow dashboard main page.
// Endpoint: POST https://analytics-api.voiceflow.com/v2/query/usage
//   header  authorization: <Voiceflow API key>   (must be WORKSPACE-level so it
//           can read every project — a single-project DM key only sees its own)
//   body    { data: { name: 'credit_usage', filter: { projectID, startTime, endTime, limit } } }
// Config: VOICEFLOW_API_KEY + VOICEFLOW_PROJECT_IDS (comma-separated list of all
//         project IDs). Optional VOICEFLOW_CREDIT_LIMIT for the "remaining" bar.
async function getVoiceflow() {
  const key = envAny(['VOICEFLOW_API_KEY', 'VF_API_KEY', 'VOICEFLOW_DM_API_KEY']);
  const idsRaw = envAny(['VOICEFLOW_PROJECT_IDS', 'VOICEFLOW_PROJECT_ID', 'VF_PROJECT_ID']);
  if (!key || !idsRaw) return { key: 'voiceflow', status: 'not-configured' };

  const ids = idsRaw.split(',').map(s => s.trim()).filter(Boolean);
  const startTime = monthStartISO();
  const endTime = new Date().toISOString();

  // Credits for one project (follows the cursor until the last page).
  async function projectCredits(projectID) {
    let total = 0, cursor, pages = 0;
    do {
      const filter = { projectID, startTime, endTime, limit: 500 };
      if (cursor) filter.cursor = cursor;
      const r = await fetch('https://analytics-api.voiceflow.com/v2/query/usage', {
        method: 'POST',
        headers: { authorization: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { name: 'credit_usage', filter } })
      });
      if (!r.ok) throw new Error(httpErr(r.status));
      const j = await r.json();
      const items = j.items || j.data || [];
      items.forEach(it => { total += num(it.count ?? it.value); });
      // Stop unless we got a full page (a partial page = last page).
      cursor = (items.length >= 500 && j.cursor) ? j.cursor : undefined;
      pages++;
    } while (cursor && pages < 25);
    return total;
  }

  try {
    // One 401 (bad/again project) shouldn't sink the whole card — swallow per project.
    const per = await Promise.all(ids.map(id => projectCredits(id).catch(() => 0)));
    const consumed = per.reduce((a, b) => a + b, 0);
    const limit = envAny(['VOICEFLOW_CREDIT_LIMIT']) ? num(envAny(['VOICEFLOW_CREDIT_LIMIT'])) : null;
    return { key: 'voiceflow', status: 'ok', unit: 'credits', consumed, limit,
             periodLabel: 'קרדיטים מתחילת החודש (כל הפרויקטים)',
             note: ids.length + ' פרויקטים' };
  } catch (e) { return { key: 'voiceflow', status: 'error', error: e.message }; }
}

// --- Resend: emails sent this month ------------------------------------------
// Resend has no "quota remaining" endpoint; we count sent emails via the list API
// and derive "remaining" from your plan allowance (RESEND_MONTHLY_LIMIT).
// Docs: https://resend.com/docs/api-reference
async function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { key: 'resend', status: 'not-configured' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const list = j.data || j.emails || [];
    const start = new Date(monthStartISO()).getTime();
    const consumed = list.filter(e => {
      const t = new Date(e.created_at || e.created || 0).getTime();
      return t >= start;
    }).length;
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

  const services = await Promise.all([getVoiceflow(), getOpenAI(), getAnthropic(), getResend()]);
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ updatedAt: new Date().toISOString(), services })
  };
};
