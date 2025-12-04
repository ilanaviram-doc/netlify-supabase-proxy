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
    // session_id שמגיע מהדפדפן הוא ה-ID של השיחה ב-Webchat
    const { session_id, user_id } = JSON.parse(event.body); 

    if (!session_id || !user_id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing parameters" }) };
    }

    console.log(`🔍 Searching transcript for SessionID: ${session_id}`);

    // === התיקון הגדול: חיפוש לפי sessionID במקום userID ===
    const listUrl = `https://analytics-api.voiceflow.com/v1/transcripts?projectID=${VF_PROJECT_ID}&sessionID=${session_id}&sort=createdAt&limit=1`;
    
    console.log(`📡 Calling URL: ${listUrl}`); // לוג דיבוג

    const listResponse = await fetch(listUrl, { 
        headers: { 'Authorization': VF_API_KEY } 
    });

    if (!listResponse.ok) {
        // אם עדיין 404 - ננסה טקטיקה אחרונה: חיפוש לפי userID (למקרה שזה משתנה)
        console.log(`⚠️ Search by SessionID failed (${listResponse.status}). Retrying with UserID...`);
        const retryUrl = `https://analytics-api.voiceflow.com/v1/transcripts?projectID=${VF_PROJECT_ID}&userID=${session_id}&sort=createdAt&limit=1`;
        
        const retryResponse = await fetch(retryUrl, { headers: { 'Authorization': VF_API_KEY } });
        
        if (!retryResponse.ok) {
             console.log(`❌ Failed to find transcript. VF Status: ${retryResponse.status}`);
             return { statusCode: 200, headers, body: JSON.stringify({ success: true, cost: 0, note: "Transcript not found" }) };
        }
        
        // אם הצלחנו בניסיון השני - נשתמש בו
        var listData = await retryResponse.json();
    } else {
        var listData = await listResponse.json();
    }
    
    // אם המערך ריק
    if (!listData || listData.length === 0) {
        console.log("⚠️ Empty list returned from Voiceflow.");
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, cost: 0 }) };
    }

    // מצאנו!
    const transcriptID = listData[0]._id;
    console.log(`✅ Found Transcript ID: ${transcriptID}`);

    // שלב 2: משיכת התמליל המלא
    const vfResponse = await fetch(`https://analytics-api.voiceflow.com/v1/transcript/${transcriptID}`, {
        headers: { 'Authorization': VF_API_KEY }
    });

    if (!vfResponse.ok) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, cost: 0 }) };
    }

    const data = await vfResponse.json();
    const turns = data.transcript?.turns || [];

    // --- חישוב עלויות ---
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
    console.log(`📊 Session Cost: ${finalCalculatedCost}`);

    // עדכון Supabase
    const { data: sessionRecord } = await supabase
        .from('processed_sessions')
        .select('charged_amount')
        .eq('session_id', transcriptID)
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
            session_id: transcriptID,
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
