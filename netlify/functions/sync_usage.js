const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const VF_API_KEY = process.env.VOICEFLOW_API_KEY;
const VF_PROJECT_ID = '68d9462f0d7ce042ebb9af90';

// === NEW: Extraction Logic based on "Logs" structure ===
function extractTextFromLog(log) {
    try {
        // 1. System/Bot Messages (Type: "trace")
        if (log.type === 'trace' && log.data && log.data.payload) {
            // Standard Text
            if (log.data.payload.message) return log.data.payload.message;
            // Slate (Rich Text)
            if (log.data.payload.slate) return JSON.stringify(log.data.payload.slate);
        }

        // 2. User Messages (Type: "action")
        if (log.type === 'action' && log.data && log.data.payload) {
            // User text is often nested in payload.payload for requests
            if (log.data.payload.payload && typeof log.data.payload.payload === 'string') {
                return log.data.payload.payload;
            }
            // Fallback for simple payload
            if (typeof log.data.payload === 'string') return log.data.payload;
        }
    } catch (e) { return ""; }
    
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

    console.log(`🔍 [SERVER] Syncing for UserID: ${session_id}`);

    // 1. Search for Transcript (POST)
    const searchUrl = `https://analytics-api.voiceflow.com/v1/transcript/project/${VF_PROJECT_ID}`;
    const searchResponse = await fetch(searchUrl, { 
        method: 'POST', 
        headers: { 
            'authorization': VF_API_KEY, 
            'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ sessionID: session_id })
    });

    if (!searchResponse.ok) {
        console.log(`❌ Search Error: ${searchResponse.status}`);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: "pending_search" }) };
    }

    const searchResult = await searchResponse.json();
    const transcriptsList = searchResult.transcripts || [];

    if (transcriptsList.length === 0) {
        console.log("⏳ VF: No transcripts found yet.");
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: "pending_index" }) };
    }

    // Get the latest transcript
    transcriptsList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const transcriptID = transcriptsList[0]._id || transcriptsList[0].id;
    console.log(`✅ Found Transcript ID: ${transcriptID}`);

    // ==================================================================
    // 2. Get Full Details (CRITICAL FIX: filterConversation=false)
    // ==================================================================
    // We add ?filterConversation=false to see the actual logs
    const detailUrl = `https://analytics-api.voiceflow.com/v1/transcript/${transcriptID}?filterConversation=false`;
    
    const detailResponse = await fetch(detailUrl, { 
        headers: { 'authorization': VF_API_KEY } 
    });

    if (!detailResponse.ok) return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };

    const data = await detailResponse.json();

    // === CRITICAL FIX: Look in 'logs' array, not turns ===
    // Source says: "logs array ⭐ This is where your messages are!"
    const logs = data.transcript?.logs || []; 

    console.log(`🐛 Raw Logs Found: ${logs.length}`); // Debug

    // ============================================================
    // 3. Calculate Costs - 🆕 UPDATED WITH 20% REDUCTION
    // ============================================================
    let totalScore = 0;
    let turnCount = 0;

    logs.forEach(log => {
        const content = extractTextFromLog(log);
        
        if (content && content.length > 1) { 
            turnCount++;
            const wordCount = content.trim().split(/\s+/).length;
            
            // 🆕 נוסחה חדשה עם הפחתה של 20% (עודכן 31/12/2024)
            const rawCost = 1 + Math.floor(wordCount / 50);
            const baseCost = Math.ceil(rawCost * 0.8);  // הפחתה של 20%
            
            // Debug log לבדיקה (אופציונלי - אפשר להסיר אחרי שזה עובד)
            if (wordCount > 50) {
                console.log(`💰 Cost calc: ${wordCount} words = ${rawCost} → ${baseCost} credits (-20%)`);
            }
            
            // Determine source based on log type
            let itemCost = 0;
            if (log.type === 'trace') { // System/Bot
                itemCost = baseCost;
            } else if (log.type === 'action') { // User
                itemCost = (baseCost * 0.5); 
            }
            
            totalScore += itemCost;
        }
    });

    const finalCalculatedCost = Math.ceil(totalScore);
    console.log(`📊 Analysis: ${turnCount} interactions. Value: ${finalCalculatedCost}`);

    // 4. Charge in Supabase
    const { data: sessionRecord } = await supabase
        .from('processed_sessions')
        .select('charged_amount')
        .eq('session_id', transcriptID)
        .single();

    const alreadyPaid = sessionRecord ? sessionRecord.charged_amount : 0;
    const amountToChargeNow = finalCalculatedCost - alreadyPaid;

    if (amountToChargeNow <= 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: "Up to date" }) };
    }

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
