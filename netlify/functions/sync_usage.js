const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const VF_API_KEY = process.env.VOICEFLOW_API_KEY;
// ה-ID של הפרויקט שלך (מהצילומים ששלחת)
const VF_PROJECT_ID = '68d9462f0d7ce042ebb9af90';

// פונקציית חילוץ טקסט שרתית
function extractTextFromTurn(payload) {
    if (!payload) return "";

    // 1. הזהב: בדיקה ישירה של השדה message (כפי שראית בטרנסקריפט)
    if (payload.message && typeof payload.message === 'string') {
        return payload.message;
    }

    // 2. בדיקות גיבוי סטנדרטיות
    if (typeof payload === 'string') return payload;
    if (payload.text) return payload.text;

    // 3. חילוץ מתוך Slate (למקרה שהפורמט משתנה בעתיד)
    if (payload.slate) {
        try { return JSON.stringify(payload.slate); } catch(e) { return ""; }
    }

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

    console.log(`🔍 [SERVER] Checking Voiceflow for Session: ${session_id}`);

    // 1. חיפוש השיחה (Transcript) ב-Voiceflow לפי SessionID
    const listUrl = `https://analytics-api.voiceflow.com/v1/transcripts?projectID=${VF_PROJECT_ID}&sessionID=${session_id}&sort=createdAt&limit=1`;
    
    const listResponse = await fetch(listUrl, { headers: { 'Authorization': VF_API_KEY } });

    // === טיפול בעיכוב של Voiceflow (החלק הסבלני) ===
    if (listResponse.status === 404) {
        console.log("⏳ VF Status: Transcript not indexed yet (Delay is normal). Will check again in 60s.");
        // מחזירים 'הצלחה' כדי שהדפדפן ימשיך לשלוח דופק
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: "pending_transcript" }) };
    }

    if (!listResponse.ok) {
        console.log(`❌ VF API Error: ${listResponse.status}`);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, cost: 0 }) };
    }

    const listData = await listResponse.json();
    
    // אם הרשימה עדיין ריקה
    if (!listData || listData.length === 0) {
        console.log("⏳ VF Status: Empty list returned. Waiting...");
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: "pending_transcript" }) };
    }

    const transcriptID = listData[0]._id;
    // console.log(`✅ Found Transcript ID: ${transcriptID}`); // אפשר להחזיר אם רוצים לוג עמוס יותר

    // 2. משיכת התוכן המלא (כאן נמצא הטקסט!)
    const vfResponse = await fetch(`https://analytics-api.voiceflow.com/v1/transcript/${transcriptID}`, {
        headers: { 'Authorization': VF_API_KEY }
    });

    if (!vfResponse.ok) return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };

    const data = await vfResponse.json();
    const turns = data.transcript?.turns || [];

    // 3. חישוב עלויות (ספירת מילים בשרת)
    let totalScore = 0;
    let turnCount = 0;

    turns.forEach(turn => {
        // סינון סוגי הודעות רלוונטיים
        if (turn.type === 'text' || turn.type === 'speak' || turn.type === 'request' || turn.type === 'launch') {
            
            const content = extractTextFromTurn(turn.payload);

            if (content && content.length > 1) { // מוודאים שזה לא סתם רווח
                turnCount++;
                const wordCount = content.trim().split(/\s+/).length;
                
                // הנוסחה: 1 בסיס + 1 לכל 50 מילים
                const baseCost = 1 + Math.floor(wordCount / 50); 
                
                let itemCost = 0;
                if (turn.source === 'system') itemCost = baseCost;
                else itemCost = (baseCost * 0.5); // הנחה למשתמש
                
                totalScore += itemCost;
            }
        }
    });

    const finalCalculatedCost = Math.ceil(totalScore);

    // 4. חיוב (דלתא) - רק אם יש שינוי
    const { data: sessionRecord } = await supabase
        .from('processed_sessions')
        .select('charged_amount')
        .eq('session_id', transcriptID) // המפתח הוא ה-TranscriptID הייחודי
        .single();

    const alreadyPaid = sessionRecord ? sessionRecord.charged_amount : 0;
    const amountToChargeNow = finalCalculatedCost - alreadyPaid;

    if (amountToChargeNow <= 0) {
        // לא מדפיסים לוג אם אין שינוי, כדי לשמור על לוג נקי
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: "Up to date" }) };
    }

    console.log(`💳 CHARGING: ${amountToChargeNow} credits (Session Total: ${finalCalculatedCost})`);

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
