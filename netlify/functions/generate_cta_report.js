// netlify/functions/generate_cta_report.js
// ============================================================
// CTA General Report Generator
// ============================================================
// Flow:
//   1. Verify user JWT
//   2. Pull aggregation data from Supabase (aggregate_cta_report_data RPC)
//   3. Pull theme definitions (get_themes_for_report RPC)
//   4. Build LLM prompt with both
//   5. Call Claude Sonnet
//   6. Parse + validate JSON response
//   7. Return structured report to frontend
//
// Frontend renders the JSON into HTML — no HTML in this function.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1500;

const ALLOWED_ORIGIN = 'https://clinikai.co';

const corsHeaders = (origin) => ({
  'Access-Control-Allow-Origin':  origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Credentials': 'true',
  'Content-Type': 'application/json'
});

// ────────────────────────────────────────────────────────────
// SYSTEM PROMPT — see 05_prompt_cta_general.md for full doc
// ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `אתה מומחה לפסיכותרפיה פסיכודינמית ולסופרוויז'ן קליני.
תפקידך לכתוב דוח התפתחות קליני אורכי על מטפל, מבוסס על שיחות הדרכה שהוא קיים בפלטפורמת ClinikAI.

עקרונות יסוד שאתה חייב לפעול לפיהם:

1. **תמה אינה כשל — היא נתון.** כל תמה במערכת היא תופעה קלינית שעולה לעיתים, לא כשל של המטפל. בעבודה עם מטופלים מורכבים, רוב התמות צפויות להופיע. השאלה אינה אם תמה הופיעה אלא מה מקורה.

2. **שאלת המקור.** לכל ממצא משמעותי, רמוז (לא במפורש בכל פסקה) על אפשרות שני מקורות:
   - תגובה ריאלית של המטפל לדינמיקה שהמטופל יוצר
   - חוויה שנשאבת מעולמו הפנימי של המטפל
   - לפעמים: הזדהות השלכתית או אנאקטמנט — חוויה שמועברת מהמטופל

3. **שפה לא-שיפוטית.** הימנע מהמילים "בעיה", "כשל", "ליקוי". השתמש ב"דפוס", "נוכחות", "תופעה", "הזמנה להתבוננות".

4. **מילים של המטפל בלבד.** אסור להוסיף פרשנות שאינה נשענת על נתוני התיוג. אם תמה מתויגת, אתה יכול לדבר עליה. אם לא — אסור להמציא.

5. **קבע פעמיים שלא, פעם אחת כן.** אם בנתונים אין מספיק חומר לטענה, אל תטען. עדיף "נראה" ו"ייתכן" על פני "ברור".

6. **קצר ועוקצני.** משפטים קצרים. שתיים-שלוש פסקאות לממצא מרכזי, לא יותר.

7. **שפה עברית מקצועית.** השתמש במונחים העבריים שמופיעים בגלוסר — לא "פיחות" אלא "דוולואציה". לא "כשירות" אלא "קומפיטנטיות".

8. **פלט JSON תקני בלבד.** ללא markdown, ללא הקדמה, ללא סיכום. רק ה-JSON.`;

// ────────────────────────────────────────────────────────────
// Build the user prompt with injected data
// ────────────────────────────────────────────────────────────
function buildUserPrompt({ aggregation, themeDefs }) {
  const counts = aggregation.counts || {};
  const dateRange = (counts.first_session && counts.last_session)
    ? `${counts.first_session.substring(0,10)} — ${counts.last_session.substring(0,10)}`
    : 'לא ידוע';

  return `המשתמש: מטפל פסיכודינמי, ${counts.total_sessions || 0} שיחות הדרכה, ${counts.total_cases || 0} מקרים שונים.
תקופה: ${dateRange}.

# הטקסונומיה (תמות פעילות):
${JSON.stringify(themeDefs, null, 2)}

# הנתונים הגולמיים מ-Supabase:
${JSON.stringify(aggregation, null, 2)}

# המטלה:
כתוב דוח התפתחות קליני אורכי על המטפל. הדוח חייב להיות JSON תקני במבנה הבא:

{
  "overview": {
    "intro_paragraph": "פסקת פתיחה של 3-4 משפטים שמתארת את הדוח. השתמש במספרי המקרים והשיחות. נסח באופן מזמין לא רשמי."
  },
  "themes_in_report": [
    "A1", "B1"
  ],
  "findings": [
    {
      "id": "f1",
      "title": "כותרת קצרה (4-7 מילים)",
      "narrative": "פסקה של 2-4 משפטים. תאר את הדפוס, רמוז על שאלת המקור, מבלי לשפוט.",
      "insight_callout": "תובנה ספציפית של 1-2 משפטים (אופציונלי, יכול להיות null).",
      "supporting_session_ids": ["session_id1"],
      "primary_themes": ["B1"]
    }
  ],
  "clusters": [
    {
      "id": "c1",
      "label": "תווית קצרה",
      "description": "משפט אחד שמתאר את האשכול ושאלת ההדרכה האופיינית שלו",
      "case_count": 2,
      "case_hashes": ["case_hash1"],
      "primary_themes": ["B1"]
    }
  ],
  "strengths": [
    {
      "id": "s1",
      "tag": "חוזקה",
      "text": "משפט קצר",
      "supporting_themes": ["D1"]
    }
  ],
  "growth_areas": [
    {
      "id": "g1",
      "tag": "צמיחה",
      "text": "משפט קצר. אל תכתוב 'עליך לעשות X' אלא 'הצעד הבא עשוי להיות X'.",
      "supporting_themes": ["B3b"]
    }
  ]
}

# הערות חשובות:
- 3-4 findings סך הכל. בחר את הדפוסים החזקים ביותר.
- 2-4 clusters. אל תאשכל אם אין באמת קבוצות מובחנות.
- 2-3 strengths ו-2-3 growth_areas.
- "supporting_session_ids" חייבים להיות מתוך הנתונים. אסור להמציא.
- "primary_themes" ו-"supporting_themes" חייבים להיות קודי תמות מהטקסונומיה.
- ב-clusters: אל תכלול את "general_reflective" או "unassigned".
- אם אין מספיק נתונים לקטגוריה — תן כמה שיש, אל תמציא.

החזר רק את ה-JSON. ללא markdown.`;
}

// ────────────────────────────────────────────────────────────
// Validate the LLM JSON against expected shape
// ────────────────────────────────────────────────────────────
function validateReport(report) {
  const errors = [];

  if (!report || typeof report !== 'object') {
    return ['Report is not an object'];
  }

  if (!report.overview?.intro_paragraph) {
    errors.push('Missing overview.intro_paragraph');
  }
  if (!Array.isArray(report.themes_in_report)) {
    errors.push('Missing or invalid themes_in_report');
  }
  if (!Array.isArray(report.findings) || report.findings.length === 0) {
    errors.push('Missing or empty findings array');
  }
  if (!Array.isArray(report.clusters)) {
    errors.push('Missing clusters array');
  }
  if (!Array.isArray(report.strengths)) {
    errors.push('Missing strengths array');
  }
  if (!Array.isArray(report.growth_areas)) {
    errors.push('Missing growth_areas array');
  }

  return errors;
}

// ────────────────────────────────────────────────────────────
// Main handler
// ────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // Auth: forward the user's JWT
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Missing auth' })
    };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: authHeader } },
    auth:   { persistSession: false }
  });

  // Get authenticated user
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Invalid token' })
    };
  }

  const userId = userData.user.id;

  // ──────────────────────────────────────────────
  // Step 1: Fetch aggregation data
  // ──────────────────────────────────────────────
  const { data: aggregation, error: aggErr } = await supabase
    .rpc('aggregate_cta_report_data', { p_user_id: userId });

  if (aggErr) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Aggregation failed', detail: aggErr.message })
    };
  }

  // Minimum threshold check
  const totalSessions = aggregation?.counts?.total_sessions || 0;
  if (totalSessions < 5) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: 'Insufficient data',
        message: `נדרשות לפחות 5 שיחות לדוח. כרגע יש ${totalSessions}.`,
        sessions_count: totalSessions
      })
    };
  }

  // ──────────────────────────────────────────────
  // Step 2: Fetch theme definitions for codes that appeared
  // ──────────────────────────────────────────────
  const themeFreq = aggregation.theme_frequency || [];
  const appearingCodes = themeFreq.map(t => t.theme);

  const { data: themeDefs, error: defErr } = await supabase
    .rpc('get_themes_for_report', { p_codes: appearingCodes });

  if (defErr) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Theme definitions fetch failed', detail: defErr.message })
    };
  }

  // ──────────────────────────────────────────────
  // Step 3: Build prompt and call Claude
  // ──────────────────────────────────────────────
  const userPrompt = buildUserPrompt({ aggregation, themeDefs });

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  let llmResponse;
  try {
    llmResponse = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userPrompt }
      ]
    });
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'LLM call failed', detail: err.message })
    };
  }

  // Extract text content
  const responseText = llmResponse.content
    ?.filter(b => b.type === 'text')
    ?.map(b => b.text)
    ?.join('\n')
    ?.trim();

  if (!responseText) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Empty LLM response' })
    };
  }

  // ──────────────────────────────────────────────
  // Step 4: Parse + validate JSON
  // ──────────────────────────────────────────────
  let report;
  try {
    // Strip any accidental markdown fences
    const cleaned = responseText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    report = JSON.parse(cleaned);
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'LLM returned invalid JSON',
        detail: err.message,
        raw_response: responseText.substring(0, 500)
      })
    };
  }

  const validationErrors = validateReport(report);
  if (validationErrors.length > 0) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Report failed validation',
        validation_errors: validationErrors,
        report  // include for debugging
      })
    };
  }

  // ──────────────────────────────────────────────
  // Step 5: Enrich response with metadata + theme defs
  // (so frontend has everything needed to render)
  // ──────────────────────────────────────────────
  const enriched = {
    report,
    metadata: {
      generated_at: new Date().toISOString(),
      model: MODEL,
      user_id: userId,
      sessions_analyzed: totalSessions,
      cases_analyzed: aggregation.counts.total_cases || 0
    },
    raw_data: {
      counts: aggregation.counts,
      theme_frequency: aggregation.theme_frequency,
      dominant_frequency: aggregation.dominant_frequency,
      cases: aggregation.cases
    },
    theme_definitions: themeDefs
  };

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(enriched)
  };
};
