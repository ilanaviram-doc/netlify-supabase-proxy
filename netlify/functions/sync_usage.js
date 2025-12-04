const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const VF_API_KEY = process.env.VOICEFLOW_API_KEY;
const VF_PROJECT_ID = '68d9462f0d7ce042ebb9af90'; // ה-ID של הפרויקט שלך

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { session_id, user_id } = JSON.parse(event.body); // session_id כאן הוא בעצם ה-UserID של Voiceflow

    if (!session_id || !user_id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing parameters" }) };
    }

    console.log(`🔍 Looking for latest transcript for VF User: ${session_id}`);

    // שדרוג: שלב 1 - חיפוש התמליל האחרון של המשתמש הזה
    const listResponse = await fetch(
        `https://analytics-api.voiceflow.com/v1/transcripts?projectID=${VF_PROJECT_ID}&userID=${session_id}&sort=createdAt&limit=1`, 
        { headers: { 'Authorization': VF_API_KEY } }
    );

    if (!listResponse.ok) {
        console.log(`❌ Failed to list transcripts: ${listResponse.status}`);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, cost: 0, note: "User check failed" }) };
    }

    const listData = await listResponse.json();
    
    // אם אין שיחות בכלל למשתמש הזה
    if (!listData || listData.length === 0) {
        console.log("⚠️ No transcripts found for this user yet.");
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, cost: 0, note: "New conversation" }) };
    }

    // מצאנו! לוקחים את ה-ID האמיתי של התמליל
    const transcriptID = listData[0]._id;
    console.log(`✅ Found Transcript ID: ${transcriptID}`);

    // שדרוג: שלב 2 - משיכת התמליל המלא לפי ה-ID שמצאנו
    const vfResponse = await fetch(`https://analytics-api.voiceflow.com/v1/transcript/${transcriptID}`, {
        headers: { 'Authorization': VF_API_KEY }
    });

    if (!vfResponse.ok) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, cost: 0 }) };
    }

    const data = await vfResponse.json();
    const turns = data.transcript?.turns || [];

    // --- מכאן הלוגיקה של החיוב נשארת אותו דבר ---
    let totalScore = 0;
    
    turns.forEach(turn => {
        if (turn.type === 'text' || turn.type === 'speak') {
            let content = "";
            if (typeof turn.payload === 'string') content = turn.payload;
            else if (turn.payload?.text) content = turn.payload.text;
            else if (turn.payload?.message) content = turn.payload.message;
            else if (turn.payload?.payload?.text) content = turn.payload.payload.text;

            if (content) {
                const wordCount = content.trim().split(/\s+/).length;
                const baseCost = 1 + (wordCount / 50); 
                
                if (turn.source === 'system') totalScore += baseCost;
                else if (turn.source === 'user') totalScore += (baseCost * 0.5);
            }
        }
    });

    const finalCalculatedCost = Math.ceil(totalScore);
    console.log(`📊 Session Value: ${finalCalculatedCost} credits`);

    // בדיקת דלתא וחיוב ב-Supabase
    const { data: sessionRecord } = await supabase
        .from('processed_sessions')
        .select('charged_amount')
        .eq('session_id', transcriptID) // משתמשים ב-ID האמיתי של התמליל כמפתח
        .single();

    const alreadyPaid = sessionRecord ? sessionRecord.charged_amount : 0;
    const amountToChargeNow = finalCalculatedCost - alreadyPaid;

    if (amountToChargeNow <= 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: "No new charges" }) };
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
            session_id: transcriptID, // שומרים לפי ה-ID של התמליל
            user_id: user_id, 
            charged_amount: finalCalculatedCost,
            last_sync: new Date().toISOString()
        }, { onConflict: 'session_id' });

        return { statusCode: 200, headers, body: JSON.stringify({ success: true, charged: amountToChargeNow }) };
    } 
    
    return { statusCode: 404, headers, body: JSON.stringify({ error: "User credits not found" }) };

  } catch (err) {
    console.error("🔥 Error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
