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

// --- Last-good-value cache (Supabase table usage_cache) ----------------------
// A slow provider (OpenAI's cost API) can time out; instead of showing an error
// we serve the last value we successfully fetched.
async function readCache(service) {
  try {
    const sbUrl = process.env.SUPABASE_URL, svc = envAny(['SUPABASE_SERVICE_ROLE_KEY']);
    if (!sbUrl || !svc) return null;
    const r = await fetchT(`${sbUrl}/rest/v1/usage_cache?service=eq.${service}&select=consumed,unit,updated_at`,
      { headers: { apikey: svc, Authorization: `Bearer ${svc}` } }, 800);
    if (!r.ok) return null;
    const rows = await r.json();
    return (rows && rows[0]) ? rows[0] : null;
  } catch { return null; }
}
async function writeCache(service, consumed, unit) {
  try {
    const sbUrl = process.env.SUPABASE_URL, svc = envAny(['SUPABASE_SERVICE_ROLE_KEY']);
    if (!sbUrl || !svc) return;
    await fetchT(`${sbUrl}/rest/v1/usage_cache?on_conflict=service`, {
      method: 'POST',
      headers: { apikey: svc, Authorization: `Bearer ${svc}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify([{ service, consumed, unit, updated_at: new Date().toISOString() }])
    }, 3000);
  } catch { /* best-effort */ }
}
function agoText(iso) {
  try {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 60) return 'עודכן לפני ' + m + ' דק׳';
    const h = Math.round(m / 60);
    if (h < 24) return 'עודכן לפני ' + h + ' שע׳';
    return 'עודכן לפני ' + Math.round(h / 24) + ' ימים';
  } catch { return 'ערך שמור'; }
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
  const limit = process.env.OPENAI_ORG_LIMIT_USD ? num(process.env.OPENAI_ORG_LIMIT_USD) : null;
  try {
    const start = Math.floor(new Date(monthStartISO()).getTime() / 1000);
    const u = new URL('https://api.openai.com/v1/organization/costs');
    u.searchParams.set('start_time', String(start));
    u.searchParams.set('limit', '31'); // month-to-date daily buckets — smaller = faster
    const r = await fetchT(u, { headers: { Authorization: `Bearer ${key}` } }, 8000);
    if (!r.ok) throw new Error(httpErr(r.status));
    const j = await r.json();
    let usd = 0;
    (j.data || []).forEach(bucket => (bucket.results || []).forEach(res => {
      const a = res.amount;
      usd += typeof a === 'object' && a !== null ? num(a.value) : num(a);
    }));
    const consumed = Math.round(usd * 100) / 100;
    await writeCache('openai', consumed, 'usd'); // remember last good value
    return { key: 'openai', status: 'ok', unit: 'usd', consumed,
             limit, periodLabel: 'עלות מתחילת החודש', note: 'תמלול קולי (STT/VTT)' };
  } catch (e) {
    // Live call was slow/failed — serve the last value we cached, so the card
    // shows a number instead of a timeout error.
    const c = await readCache('openai');
    if (c) return { key: 'openai', status: 'ok', unit: c.unit || 'usd', consumed: num(c.consumed),
                    limit, periodLabel: 'עלות מתחילת החודש', note: agoText(c.updated_at) };
    return { key: 'openai', status: 'error', error: e.message };
  }
}

// --- Voiceflow: PER-PROJECT usage breakdown ----------------------------------
// Voiceflow keys are project-scoped, so we keep a project_id -> VF.DM key map in
// the Supabase table `voiceflow_project_keys` (read here with the service_role
// key — the keys are secret and RLS blocks everyone else). For each project we
// query credit_usage and report interactions + credits, sorted by activity.
async function getVoiceflow() {
  const billingUrl = process.env.VOICEFLOW_BILLING_URL || 'https://creator.voiceflow.com/workspace/VzElM4eVkL/projects';
  const linkCard = (note) => ({ key: 'voiceflow', status: 'link', url: billingUrl,
                                linkLabel: 'צפה בעלות ב-Voiceflow', note });

  const svcKey = envAny(['SUPABASE_SERVICE_ROLE_KEY']);
  const sbUrl = process.env.SUPABASE_URL;
  if (!svcKey || !sbUrl) return linkCard('חסר SUPABASE_SERVICE_ROLE_KEY');

  try {
    // Read the project->key map (secret keys → service_role only).
    const rq = await fetchT(`${sbUrl}/rest/v1/voiceflow_project_keys?select=project_id,name,dm_key,enabled`,
      { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } }, 6000);
    if (!rq.ok) throw new Error('supabase ' + rq.status);
    const rows = await rq.json();
    const active = (rows || []).filter(x => x.enabled !== false && x.dm_key && String(x.dm_key).trim());
    if (!active.length) return linkCard('הוסף מפתחות בטבלת voiceflow_project_keys');

    const startTime = monthStartISO();
    const endTime = new Date().toISOString();

    async function projectUsage(row) {
      let credits = 0, interactions = 0, cursor, pages = 0, dbg = '';
      do {
        const filter = { projectID: row.project_id, startTime, endTime, limit: 500 };
        if (cursor) filter.cursor = cursor;
        const rr = await fetchT('https://analytics-api.voiceflow.com/v2/query/usage', {
          method: 'POST',
          headers: { authorization: row.dm_key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: { name: 'credit_usage', filter } })
        }, 6000);
        if (!rr.ok) throw new Error(httpErr(rr.status));
        const j = await rr.json();
        // Find the rows array wherever Voiceflow put it — guarded so a non-array
        // value can never crash the loop.
        let items = [];
        if (Array.isArray(j)) items = j;
        else if (Array.isArray(j.items)) items = j.items;
        else if (Array.isArray(j.data)) items = j.data;
        else if (Array.isArray(j.result)) items = j.result;
        else if (j.data && Array.isArray(j.data.items)) items = j.data.items;
        else if (j.result && Array.isArray(j.result.items)) items = j.result.items;
        else if (j.data && Array.isArray(j.data.data)) items = j.data.data;
        // Capture the raw shape of the first response if we found no rows.
        if (pages === 0 && !items.length) dbg = JSON.stringify(j).slice(0, 260);
        for (const it of items) {
          const c = num(it.count ?? it.value ?? it.credits ?? it.total ?? 0);
          credits += c;
          if (it.type === 'interaction' || it.name === 'interactions') interactions += c;
        }
        cursor = (items.length >= 500 && j.cursor) ? j.cursor : undefined;
        pages++;
      } while (cursor && pages < 25);
      return { name: row.name || row.project_id, credits, interactions, dbg };
    }

    const results = await Promise.all(active.map(async (r) => {
      try { return { ok: true, ...(await projectUsage(r)) }; }
      catch (e) { return { ok: false, name: r.name || r.project_id, error: (e && e.message) || String(e) }; }
    }));
    const items = results.filter(x => x.ok).map(x => ({ name: x.name, credits: x.credits, interactions: x.interactions }))
                         .sort((a, b) => (b.interactions - a.interactions) || (b.credits - a.credits));
    const failedList = results.filter(x => !x.ok);
    if (!items.length) {
      return linkCard('כל הפרויקטים נכשלו: ' + (failedList[0] ? failedList[0].error : ''));
    }
    const total = items.reduce((a, b) => a + b.credits, 0);
    let note = items.length + ' פרויקטים';
    if (failedList.length) note += ' · נכשלו: ' + failedList.map(f => f.name).join(', ');
    // If everything came back empty, expose the raw response shape so we can see why.
    if (total === 0) {
      const firstOk = results.find(x => x.ok && x.dbg);
      if (firstOk) note += ' · debug: ' + firstOk.dbg;
    }
    return {
      key: 'voiceflow', status: 'breakdown', unit: 'credits',
      total, totalInteractions: items.reduce((a, b) => a + b.interactions, 0),
      items, url: billingUrl, linkLabel: 'צפה בעלות ב-Voiceflow', note
    };
  } catch (e) { return linkCard(e.message); }
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
