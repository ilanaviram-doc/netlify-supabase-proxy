// netlify/functions/generate_cta_report.js
// ============================================================
// CTA General Report Generator — v2
// ============================================================
// Improvements over v1:
//   - MAX_TOKENS = 3500 (enough for full report, fits in <30s)
//   - System prompt enforces strict JSON output (no markdown)
//   - Robust JSON parsing: strips markdown wrappers + handles
//     trailing commas + extracts JSON from any noise
//   - Truncated-JSON detection with clear error
//   - temperature: 0.3 for consistent output
//   - CORS headers on ALL response paths
//   - Internal console.log for fast Netlify debugging
//   - Uses Haiku 4.5 by default (fast + cheap)
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 3500;
const TEMPERATURE = 0.3;

const ALLOWED_ORIGIN = 'https://clinikai.co';

const corsHeaders = (origin) => ({
  'Access-Control-Allow-Origin':  origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Credentials': 'true',
  'Content-Type': 'application/json'
});

// Helper to build error responses with CORS headers always present
const errorResponse = (origin, statusCode, body) => ({
  statusCode,
  headers: corsHeaders(origin),
  body: JSON.stringify(body)
});

// ────────────────────────────────────────────────────────────
// SYSTEM PROMPT — strict JSON output
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

==========================================
פלט: JSON תקני בלבד
==========================================

קריטי: התשובה שלך חייבת להיות JSON תקני בלבד.
- אל תעטוף את ה-JSON ב-\`\`\`json או \`\`\` או כל wrapper אחר.
- אל תוסיף הקדמה, סיכום, או הסברים.
- אל תכלול comments בתוך ה-JSON.
- אל תשתמש ב-trailing commas.
- כל מחרוזת חייבת להיות בתוך מירכאות כפולות.
- התחל את התשובה עם { וסיים עם }.

החזק את הניסוחים תמציתיים כדי לעמוד במגבלת ה-tokens. עדיף ממצא מובהק קצר על ממצא מפותל ארוך.`;

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
כתוב דוח התפתחות קליני אורכי על המטפל במבנה JSON הבא.

מבנה הדוח:
{
  "overview": {
    "intro_paragraph": "פסקה של 3-4 משפטים. כללי, מזמין, לא רשמי."
  },
  "themes_in_report": ["A1", "B1"],
  "findings": [
    {
      "id": "f1",
      "title": "כותרת קצרה",
      "narrative": "2-4 משפטים. דפוס + רמז למקור.",
      "insight_callout": "תובנה ספציפית או null",
      "supporting_session_ids": ["session_id1"],
      "primary_themes": ["B1"]
    }
  ],
  "clusters": [
    {
      "id": "c1",
      "label": "תווית",
      "description": "משפט אחד",
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
      "text": "הצעד הבא עשוי להיות X (לא 'עליך לעשות X')",
      "supporting_themes": ["B3b"]
    }
  ]
}

הנחיות לכמויות:
- findings: בדיוק 3 (לא יותר)
- clusters: 2-3
- strengths: 2-3
- growth_areas: 2

הנחיות חמורות:
- supporting_session_ids ו-case_hashes חייבים להיות מתוך הנתונים. אסור להמציא.
- primary_themes ו-supporting_themes חייבים להיות קודי תמות מהטקסונומיה.
- ב-clusters: אל תכלול "general_reflective" או "unassigned".
- אם אין מספיק נתונים לקטגוריה — תן פחות, אל תמציא.

החזר רק את ה-JSON. שום דבר אחר.`;
}

// ────────────────────────────────────────────────────────────
// Extract JSON from response — robust to wrappers + noise
// ────────────────────────────────────────────────────────────
function extractJSON(text) {
  if (!text) return null;

  // Strip markdown code fences (json/javascript/empty)
  let cleaned = text
    .replace(/^```(?:json|javascript|js)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  // Find first { and last } - extract just the JSON part
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  cleaned = cleaned.substring(firstBrace, lastBrace + 1);

  // Remove trailing commas before } or ] (common LLM error)
  cleaned = cleaned
    .replace(/,(\s*})/g, '$1')
    .replace(/,(\s*])/g, '$1');

  return cleaned;
}

// ────────────────────────────────────────────────────────────
// Detect if JSON looks truncated (Claude hit max_tokens mid-output)
// ────────────────────────────────────────────────────────────
// Only consider response truncated if Claude explicitly says so via
// stop_reason. We do NOT inspect the last character because Claude
// sometimes wraps JSON in markdown fences (```) and trailing backticks
// would create false positives. The extractJSON() function handles
// any wrappers downstream.
function looksTruncated(_text, stopReason) {
  return stopReason === 'max_tokens';
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
  const startTime = Date.now();

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return errorResponse(origin, 405, { error: 'Method not allowed' });
  }

  console.log('[CTA] Request received');

  // Verify env vars
  if (!SUPABASE_URL || !SUPABASE_ANON || !ANTHROPIC_API_KEY) {
    console.error('[CTA] Missing env vars:', {
      hasUrl: !!SUPABASE_URL,
      hasAnon: !!SUPABASE_ANON,
      hasAnthropic: !!ANTHROPIC_API_KEY
    });
    return errorResponse(origin, 500, { error: 'Server config missing env vars' });
  }

  // Auth: forward the user's JWT
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return errorResponse(origin, 401, { error: 'Missing auth' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: authHeader } },
    auth:   { persistSession: false }
  });

  // Get authenticated user
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    return errorResponse(origin, 401, { error: 'Invalid token', detail: userErr?.message });
  }

  const userId = userData.user.id;
  console.log('[CTA] Authenticated user:', userId);

  // ──────────────────────────────────────────────
  // Step 1: Fetch aggregation data
  // ──────────────────────────────────────────────
  const { data: aggregation, error: aggErr } = await supabase
    .rpc('aggregate_cta_report_data', { p_user_id: userId });

  if (aggErr) {
    console.error('[CTA] Aggregation failed:', aggErr.message);
    return errorResponse(origin, 500, { error: 'Aggregation failed', detail: aggErr.message });
  }

  const totalSessions = aggregation?.counts?.total_sessions || 0;
  console.log('[CTA] Sessions:', totalSessions);

  if (totalSessions < 5) {
    return errorResponse(origin, 400, {
      error: 'Insufficient data',
      message: `נדרשות לפחות 5 שיחות לדוח. כרגע יש ${totalSessions}.`,
      sessions_count: totalSessions
    });
  }

  // ──────────────────────────────────────────────
  // Step 2: Fetch theme definitions for codes that appeared
  // ──────────────────────────────────────────────
  const themeFreq = aggregation.theme_frequency || [];
  const appearingCodes = themeFreq.map(t => t.theme);
  console.log('[CTA] Appearing theme codes:', appearingCodes.length);

  const { data: themeDefs, error: defErr } = await supabase
    .rpc('get_themes_for_report', { p_codes: appearingCodes });

  if (defErr) {
    console.error('[CTA] Theme defs failed:', defErr.message);
    return errorResponse(origin, 500, { error: 'Theme definitions fetch failed', detail: defErr.message });
  }

  // ──────────────────────────────────────────────
  // Step 3: Build prompt and call Claude
  // ──────────────────────────────────────────────
  const userPrompt = buildUserPrompt({ aggregation, themeDefs });
  console.log('[CTA] Prompt length:', userPrompt.length, 'chars');

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  let llmResponse;
  const llmStart = Date.now();
  try {
    llmResponse = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userPrompt }
      ]
    });
  } catch (err) {
    console.error('[CTA] LLM call failed:', err.message);
    return errorResponse(origin, 500, { error: 'LLM call failed', detail: err.message });
  }

  const llmElapsed = ((Date.now() - llmStart) / 1000).toFixed(1);
  console.log('[CTA] LLM completed in', llmElapsed, 'seconds');
  console.log('[CTA] Stop reason:', llmResponse.stop_reason);
  console.log('[CTA] Output tokens:', llmResponse.usage?.output_tokens);

  // Extract text content
  const responseText = llmResponse.content
    ?.filter(b => b.type === 'text')
    ?.map(b => b.text)
    ?.join('\n')
    ?.trim();

  if (!responseText) {
    return errorResponse(origin, 500, { error: 'Empty LLM response' });
  }

  // ──────────────────────────────────────────────
  // Step 4: Check for truncation
  // ──────────────────────────────────────────────
  if (looksTruncated(responseText, llmResponse.stop_reason)) {
    console.error('[CTA] Response truncated. stop_reason:', llmResponse.stop_reason);
    return errorResponse(origin, 500, {
      error: 'LLM response was truncated (hit max_tokens)',
      detail: `stop_reason: ${llmResponse.stop_reason}, output_tokens: ${llmResponse.usage?.output_tokens}`,
      suggestion: 'Increase MAX_TOKENS in the function, or reduce findings/clusters count in prompt',
      raw_response_tail: responseText.slice(-500)
    });
  }

  // ──────────────────────────────────────────────
  // Step 5: Parse + validate JSON
  // ──────────────────────────────────────────────
  const cleanedJSON = extractJSON(responseText);

  if (!cleanedJSON) {
    console.error('[CTA] Could not extract JSON from response');
    return errorResponse(origin, 500, {
      error: 'Could not extract JSON from LLM response',
      raw_response_head: responseText.substring(0, 500)
    });
  }

  let report;
  try {
    report = JSON.parse(cleanedJSON);
  } catch (err) {
    console.error('[CTA] JSON parse failed:', err.message);
    return errorResponse(origin, 500, {
      error: 'LLM returned invalid JSON',
      detail: err.message,
      raw_response_head: responseText.substring(0, 500),
      cleaned_attempt_head: cleanedJSON.substring(0, 500)
    });
  }

  const validationErrors = validateReport(report);
  if (validationErrors.length > 0) {
    console.error('[CTA] Validation errors:', validationErrors);
    return errorResponse(origin, 500, {
      error: 'Report failed validation',
      validation_errors: validationErrors,
      report
    });
  }

  // ──────────────────────────────────────────────
  // Step 6: Enrich response with metadata + theme defs
  // ──────────────────────────────────────────────
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('[CTA] Total elapsed:', totalElapsed, 'seconds');

  const enriched = {
    report,
    metadata: {
      generated_at: new Date().toISOString(),
      model: MODEL,
      user_id: userId,
      sessions_analyzed: totalSessions,
      cases_analyzed: aggregation.counts.total_cases || 0,
      llm_elapsed_seconds: parseFloat(llmElapsed),
      total_elapsed_seconds: parseFloat(totalElapsed),
      output_tokens: llmResponse.usage?.output_tokens,
      stop_reason: llmResponse.stop_reason
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
    headers: corsHeaders(origin),
    body: JSON.stringify(enriched)
  };
};
