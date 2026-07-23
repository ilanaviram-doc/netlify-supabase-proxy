// netlify/functions/vf-redaction-proxy.mjs
// ---------------------------------------------------------------------------
// Reverse-proxy בין ווידג'ט Voiceflow לבין general-runtime.voiceflow.com
// מנקה פרטים מזהים מכל טקסט שהמשתמש שולח, לפני שהוא עוזב את התשתית שלך.
//
// גרסה 2 — תיקון plumbing של כותרות:
//   • מסירים content-length מהבקשה (הגוף משתנה אחרי רדקשן → אורך חדש)
//   • מבקשים תשובה לא-דחוסה (accept-encoding: identity) ומסירים
//     content-encoding/content-length מהתשובה, כדי שהדפדפן יפענח נכון.
// ---------------------------------------------------------------------------

const RUNTIME_ORIGIN = 'https://general-runtime.voiceflow.com';
const FUNCTION_PREFIX = '/.netlify/functions/vf-redaction-proxy';

// ─────────────────────────────────────────────────────────────────────────
// שכבת הרדקשן — דטרמיניסטית, בלי צד שלישי
// ─────────────────────────────────────────────────────────────────────────
function isValidIsraeliID(raw) {
  const id = String(raw).trim();
  if (!/^\d{5,9}$/.test(id)) return false;
  const padded = id.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let inc = Number(padded[i]) * ((i % 2) + 1);
    if (inc > 9) inc -= 9;
    sum += inc;
  }
  return sum % 10 === 0;
}

const PATTERNS = [
  { tag: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { tag: 'PHONE', re: /(?:\+972[-\s]?|0)(?:5\d|[2-489])[-\s]?\d{3}[-\s]?\d{4}\b/g },
  { tag: 'DATE',  re: /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|\b\d{4}[./-]\d{1,2}[./-]\d{1,2}\b/g },
];

function redactIDs(text) {
  return text.replace(/\b\d{5,9}\b/g, (m) => (isValidIsraeliID(m) ? '[ת״ז]' : m));
}

function redactText(input) {
  if (typeof input !== 'string' || !input) return input;
  let out = redactIDs(input);
  for (const { tag, re } of PATTERNS) out = out.replace(re, `[${tag}]`);
  return out;
  // שמות פרטיים אינם מכוסים כאן (דורש NER — ראה השיחה).
}

function redactRequestBody(node) {
  if (Array.isArray(node)) return node.map(redactRequestBody);
  if (node && typeof node === 'object') {
    const clone = {};
    for (const [k, v] of Object.entries(node)) {
      if (
        (k === 'payload' || k === 'query' || k === 'text' || k === 'message') &&
        typeof v === 'string' &&
        (node.type === 'text' || node.type === 'intent' || node.type === undefined)
      ) {
        clone[k] = redactText(v);
      } else {
        clone[k] = redactRequestBody(v);
      }
    }
    return clone;
  }
  return node;
}

// ─────────────────────────────────────────────────────────────────────────
// הפרוקסי
// ─────────────────────────────────────────────────────────────────────────
export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  const incomingUrl = new URL(request.url);
  const subPath = incomingUrl.pathname.replace(FUNCTION_PREFIX, '');
  const targetUrl = RUNTIME_ORIGIN + subPath + incomingUrl.search;

  // כותרות לבקשה: מסירים כאלה שאסור/מזיק להעביר
  const fwdHeaders = new Headers(request.headers);
  fwdHeaders.delete('host');
  fwdHeaders.delete('connection');
  fwdHeaders.delete('content-length');   // ← הגוף משתנה אחרי רדקשן; שיחושב מחדש
  fwdHeaders.set('accept-encoding', 'identity'); // ← בקש תשובה לא-דחוסה

  let body;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const raw = await request.text();
    if (raw) {
      try {
        body = JSON.stringify(redactRequestBody(JSON.parse(raw))); // ← הניקוי
      } catch {
        body = raw; // גוף שאינו JSON — כמו שהוא
      }
    }
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: request.method,
      headers: fwdHeaders,
      body,
    });
  } catch (err) {
    return new Response(JSON.stringify({ proxyError: String(err) }), {
      status: 502,
      headers: { 'content-type': 'application/json', ...corsHeaders(request) },
    });
  }

  // כותרות לתשובה: מסירים כאלה שיבלבלו את הדפדפן אחרי שהגוף כבר לא דחוס
  const respHeaders = new Headers(upstream.headers);
  respHeaders.delete('content-encoding');   // ← כבר לא דחוס
  respHeaders.delete('content-length');     // ← אורך אולי השתנה
  respHeaders.delete('transfer-encoding');
  respHeaders.delete('connection');
  for (const [k, v] of Object.entries(corsHeaders(request))) respHeaders.set(k, v);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
};

function corsHeaders(request) {
  const origin = request.headers.get('origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':
      request.headers.get('access-control-request-headers') || '*',
  };
}
