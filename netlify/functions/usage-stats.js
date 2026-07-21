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
//   VOICEFLOW_API_KEY       Voiceflow Dialog Manager API key (VF.DM.xxxx)
//   VOICEFLOW_PROJECT_ID    Voiceflow project id (for analytics)
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

// --- Voiceflow: interactions this month (Analytics API) ----------------------
// Docs: https://docs.voiceflow.com/docs/analytics
// Note: Voiceflow's public analytics API exposes interaction/usage counts.
// "Credits remaining" is a plan concept — set VOICEFLOW_CREDIT_LIMIT to derive it.
async function getVoiceflow() {
  const key = process.env.VOICEFLOW_API_KEY;
  const project = process.env.VOICEFLOW_PROJECT_ID;
  if (!key || !project) return { key: 'voiceflow', status: 'not-configured' };
  try {
    const r = await fetch('https://analytics-api.voiceflow.com/v1/query/usage', {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: [{
          name: 'interactions',
          filter: { projectID: project, startTime: monthStartISO(), endTime: new Date().toISOString() }
        }]
      })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    // Response shape varies; pull the first numeric count we find.
    let consumed = 0;
    const first = (j.result || j.data || [])[0];
    if (first) consumed = num(first.count ?? first.value ?? (first.data && first.data[0] && first.data[0].count));
    const limit = process.env.VOICEFLOW_CREDIT_LIMIT ? num(process.env.VOICEFLOW_CREDIT_LIMIT) : null;
    return { key: 'voiceflow', status: 'ok', unit: limit ? 'credits' : 'credits', consumed,
             limit, periodLabel: 'צריכה מתחילת החודש' };
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
