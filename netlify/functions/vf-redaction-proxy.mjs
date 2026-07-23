// netlify/functions/vf-redaction-proxy.mjs
// ---------------------------------------------------------------------------
// Reverse-proxy בין ווידג'ט Voiceflow לבין general-runtime.voiceflow.com
// מנקה פרטים מזהים מכל טקסט שהמשתמש שולח, לפני שהוא עוזב את התשתית שלך.
//
// חיבור (2 צעדים):
//  1. פרוס את הקובץ הזה תחת netlify/functions/ באתר / ב-netlify-supabase-proxy.
//  2. ב-index.html, ב-loadChat, שנה:
//        url: 'https://general-runtime.voiceflow.com'
//     ל:
//        url: 'https://<your-site>/.netlify/functions/vf-redaction-proxy'
//     (או הגדר redirect ב-netlify.toml ותן url קצר יותר — ראה הערה בתחתית)
//
// ⚠️ צריך פעם אחת לוודא מול DevTools → Network אילו נתיבים בדיוק הווידג'ט קורא
//    (state/interact) כדי לוודא שה-splat עובר נכון. הרדקשן עצמו — למטה — מוכן.
// ---------------------------------------------------------------------------

const RUNTIME_ORIGIN = 'https://general-runtime.voiceflow.com';

// ─────────────────────────────────────────────────────────────────────────
// שכבת הרדקשן — דטרמיניסטית, בלי צד שלישי
// ─────────────────────────────────────────────────────────────────────────

// ולידציית ספרת ביקורת לתעודת זהות ישראלית (אלגוריתם לוהן המותאם)
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
  // מייל
  { tag: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // טלפון ישראלי: 05x-xxxxxxx, 0x-xxxxxxx, +972...
  { tag: 'PHONE', re: /(?:\+972[-\s]?|0)(?:5\d|[2-489])[-\s]?\d{3}[-\s]?\d{4}\b/g },
  // תאריכים: 12/03/1990, 12.3.90, 1990-03-12
  { tag: 'DATE', re: /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|\b\d{4}[./-]\d{1,2}[./-]\d{1,2}\b/g },
];

// ת"ז מטופלת בנפרד כי צריך ולידציית checksum (לא כל 9 ספרות = ת"ז)
function redactIDs(text) {
  return text.replace(/\b\d{5,9}\b/g, (m) => (isValidIsraeliID(m) ? '[ת״ז]' : m));
}

function redactText(input) {
  if (typeof input !== 'string' || !input) return input;
  let out = redactIDs(input);
  for (const { tag, re } of PATTERNS) out = out.replace(re, `[${tag}]`);
  return out;
  // NOTE: שמות פרטיים אינם מכוסים כאן. זיהוי שמות בעברית דורש שלב NER —
  // ואסור להעביר את הטקסט הגולמי לספק צד-שלישי לשם כך (זה מחזיר את הדליפה).
  // ההמלצה: (1) regex מכסה את המידע המובנה בוודאות, (2) הנחיה בממשק
  // "אנא תארו ללא שמות", (3) בהמשך — NER מקומי/עצמאי. ראה השיחה.
}

// עובר רקורסיבית על גוף הבקשה ומנקה כל payload של הודעת משתמש מסוג text
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
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  const incomingUrl = new URL(request.url);
  // הסר את הקידומת של הפונקציה כדי לקבל את הנתיב שהווידג'ט התכוון אליו
  const subPath = incomingUrl.pathname.replace(
    /^\/\.netlify\/functions\/vf-redaction-proxy/,
    ''
  );
  const targetUrl = RUNTIME_ORIGIN + subPath + incomingUrl.search;

  // נקה כותרות שאסור להעביר הלאה
  const fwdHeaders = new Headers(request.headers);
  fwdHeaders.delete('host');
  fwdHeaders.delete('connection');

  let body;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const raw = await request.text();
    try {
      const parsed = JSON.parse(raw);
      body = JSON.stringify(redactRequestBody(parsed)); // ← כאן קורה הניקוי
    } catch {
      body = raw; // גוף שאינו JSON — מעבירים כמו שהוא
    }
  }

  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers: fwdHeaders,
    body,
  });

  const respHeaders = new Headers(upstream.headers);
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

// ─────────────────────────────────────────────────────────────────────────
// אופציונלי — netlify.toml ל-url קצר יותר:
//   [[redirects]]
//     from = "/vf/*"
//     to   = "/.netlify/functions/vf-redaction-proxy/:splat"
//     status = 200
//   ואז ב-index.html: url: 'https://<your-site>/vf'
// ─────────────────────────────────────────────────────────────────────────
