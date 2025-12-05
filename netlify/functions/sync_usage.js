const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const VF_API_KEY = process.env.VOICEFLOW_API_KEY;
const VF_PROJECT_ID = '68d9462f0d7ce042ebb9af90';

function extractTextFromTurn(payload) {
    if (!payload) return "";
    if (payload.message && typeof payload.message === 'string') return payload.message;
    if (typeof payload === 'string') return payload;
    if (payload.text) return payload.text;
    if (payload.slate) { try { return JSON.stringify(payload.slate); } catch(e) { return ""; } }
    return "";
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { session_id, user_id } = JSON.parse(event.body);

    if (!session_id || !user_id) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing params" }) };

    console.log(`🔍 [SERVER] Syncing for VF ID: ${session_id}`);

    // 1. חיפוש (POST)
    const searchUrl = `https://analytics-api.voiceflow.com/v1/transcript/project/${VF_PROJECT_ID}`;
    const searchResponse = await fetch(searchUrl, { 
        method: 'POST', 
        headers: { 'authorization': VF_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionID: session_id })
    });

    if (!searchResponse.ok) return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: "pending_search" }) };

    const searchResult = await searchResponse.json();
    const transcriptsList = searchResult.transcripts || [];

    if (transcriptsList.length === 0) return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: "pending_index" }) };

    transcriptsList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const transcriptID = transcriptsList[0]._id || transcriptsList[0].id;
    console.log(`✅ Found Transcript ID: ${transcriptID}`);

    // 2. משיכת הפרטים (GET)
    const detailUrl = `https://analytics-api.voiceflow.com/v1/transcript/${transcriptID}`;
    const detailResponse = await fetch(detailUrl, { headers: { 'authorization': VF_API_KEY } });

    if (!detailResponse.ok) return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };

    const data = await detailResponse.json();

    // === ה-X-RAY: הדפסת המבנה האמיתי ללוג ===
    console.log("🐛 DEBUG RAW DATA:", JSON.stringify(data).substring(0, 1000)); 

    // ניסיון לנחש איפה המידע מסתתר
    const turns = Array.isArray(data) ? data : (data.transcript || data.turns || []);

    // 3. חישוב
    let totalScore = 0;
    let turnCount = 0;

    turns.forEach(turn => {
        // לוגיקה מקלה - סופרים הכל כדי לראות אם יש משהו
        const content = extractTextFromTurn(turn.payload);
        if (content) { 
            turnCount++;
            const wordCount = content.trim().split(/\s+/).length;
            const baseCost = 1 + Math.floor(wordCount / 50); 
            totalScore += (turn.source === 'system' ? baseCost : baseCost * 0.5); 
        }
    });

    const finalCalculatedCost = Math.ceil(totalScore);
    console.log(`📊 Stats: ${turnCount} turns. Total Value: ${finalCalculatedCost}`);

    // 4. חיוב
    const { data: sessionRecord } = await supabase
        .from('processed_sessions')
        .select('charged_amount')
        .eq('session_id', transcriptID)
        .single();

    const alreadyPaid = sessionRecord ? sessionRecord.charged_amount : 0;
    const amountToChargeNow = finalCalculatedCost - alreadyPaid;

    if (amountToChargeNow <= 0) return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: "Up to date" }) };

    console.log(`💳 CHARGING: ${amountToChargeNow} credits`);

    const { data: userCredits } = await supabase
        .from('user_credits')
        .select('remaining_credits')
        .eq('user_id', user_id)
        .single();

    if (userCredits) {
        const newBalance = userCredits.remaining_credits - amountToChargeNow;
        await supabase.from('user_credits').update({ remaining_credits: newBalance }).eq('user_id', user_id);
        
        await supabase.from('processed_sessions').upsert({ 
            session_id: transcriptID,
            user_id: user_id, 
            charged_amount: finalCalculatedCost,
            last_sync: new Date().toISOString()
        }, { onConflict: 'session_id' });

        return { statusCode: 200, headers, body: JSON.stringify({ success: true, charged: amountToChargeNow }) };
    } 
    
    return { statusCode: 404, headers, body: JSON.stringify({ error: "User not found" }) };

  } catch (err) {
    console.error("🔥 Server Error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
