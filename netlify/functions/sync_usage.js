const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const VF_API_KEY = process.env.VOICEFLOW_API_KEY;
const VF_PROJECT_ID = '68d9462f0d7ce042ebb9af90';

// פונקציית חילוץ טקסט חכמה
function extractTextFromTurn(payload) {
    if (!payload) return "";
    // 1. הזהב: הודעה נקייה
    if (payload.message && typeof payload.message === 'string') return payload.message;
    // 2. גיבויים
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
    // אנחנו מקבלים את המזהה מהדפדפן (שהוא בעצם UserID ב-Webchat)
    const { session_id, user_id } = JSON.parse(event.body);

    if (!session_id || !user_id) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing params" }) };

    console.log(`🔍 [SERVER] Searching transcripts for UserID: ${session_id}`);

    // === תיקון 1: חיפוש לפי userID (ולא sessionID) ===
    // === תיקון 2: מיון לפי תאריך יצירה יורד (הכי חדש) ===
    const listUrl = `https://analytics-api.voiceflow.com/v1/transcripts?projectID=${VF_PROJECT_ID}&userID=${session_id}&sort=createdAt&limit=1`;
    
    // === תיקון 3: Header באותיות קטנות (לפי המסמך ששלחת) ===
    const listResponse = await fetch(listUrl, { 
        headers: { 
            'authorization': VF_API_KEY,
            'accept': 'application/json'
        } 
    });

    if (!listResponse.ok) {
        console.log(`❌ VF Error: ${listResponse.status} ${listResponse.statusText}`);
        
        // ניסיון גיבוי: אולי זה בכל זאת SessionID? (ליתר ביטחון)
        const retryUrl = `https://analytics-api.voiceflow.com/v1/transcripts?projectID=${VF_PROJECT_ID}&sessionID=${session_id}&sort=createdAt&limit=1`;
        const retryRes = await fetch(retryUrl, { headers: { 'authorization': VF_API_KEY } });
        
        if (retryRes.ok) {
             var listData = await retryRes.json();
             console.log("✅ Recovered! Found using SessionID fallback.");
        } else {
             // אם שניהם נכשלו - מחזירים 'המתנה'
             return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: "pending_transcript" }) };
        }
    } else {
        var listData = await listResponse.json();
    }
    
    if (!listData || listData.length === 0) {
        console.log("⏳ No transcripts found for this user yet.");
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: "pending_transcript" }) };
    }

    // מצאנו את השיחה!
    const transcriptID = listData[0]._id;
    console.log(`✅ Found Transcript ID: ${transcriptID}`);

    // 2. משיכת התוכן המלא
    const vfResponse = await fetch(`https://analytics-api.voiceflow.com/v1/transcript/${transcriptID}`, {
        headers: { 'authorization': VF_API_KEY } // גם כאן אותיות קטנות
    });

    if (!vfResponse.ok) return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };

    const data = await vfResponse.json();
    const turns = data.transcript?.turns || [];

    // 3. חישוב עלויות
    let totalScore = 0;
    let turnCount = 0;

    turns.forEach(turn => {
        if (turn.type === 'text' || turn.type === 'speak' || turn.type === 'request' || turn.type === 'launch') {
            const content = extractTextFromTurn(turn.payload);
            if (content && content.length > 1) { 
                turnCount++;
                const wordCount = content.trim().split(/\s+/).length;
                const baseCost = 1 + Math.floor(wordCount / 50); 
                
                if (turn.source === 'system') totalScore += baseCost;
                else totalScore += (baseCost * 0.5); 
            }
        }
    });

    const finalCalculatedCost = Math.ceil(totalScore);
    console.log(`📊 Validated: ${turnCount} turns. Value: ${finalCalculatedCost}`);

    // 4. חיוב ב-Supabase
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
