const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const VF_API_KEY = process.env.VOICEFLOW_API_KEY;

exports.handler = async (event) => {
  // הגדרות CORS (כדי שהדפדפן יסכים לדבר עם השרת)
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { session_id, user_id } = JSON.parse(event.body);

    if (!session_id || !user_id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing parameters" }) };
    }

    // 1. קריאה ל-Voiceflow API
    console.log(`🔍 Fetching transcript for Session ID: ${session_id}`);
    
    const vfResponse = await fetch(`https://analytics-api.voiceflow.com/v1/transcript/${session_id}`, {
        headers: { 
            'Authorization': VF_API_KEY,
            'Content-Type': 'application/json'
        }
    });

    // === דיבוג קריטי: למה Voiceflow נכשל? ===
    if (!vfResponse.ok) {
        const status = vfResponse.status;
        const errText = await vfResponse.text();
        
        console.log(`❌ Voiceflow Error: [${status}]`);
        console.log(`❌ Details: ${errText}`);

        // לא נחזיר שגיאה לדפדפן כדי לא לשבור את האתר, רק נדווח שהעלות 0 כרגע
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, cost: 0, note: "Transcript fetch failed" }) };
    }

    const data = await vfResponse.json();
    const turns = data.transcript?.turns || [];

    // 2. חישוב עלויות חכם (מילים + הנחה)
    let totalScore = 0;
    let turnCount = 0;

    turns.forEach(turn => {
        // בודקים רק הודעות טקסט/דיבור
        if (turn.type === 'text' || turn.type === 'speak') {
            
            // חילוץ תוכן בצורה בטוחה (עמיד לשינויים ב-API)
            let content = "";
            if (typeof turn.payload === 'string') content = turn.payload;
            else if (turn.payload?.text) content = turn.payload.text;
            else if (turn.payload?.message) content = turn.payload.message;
            else if (turn.payload?.payload?.text) content = turn.payload.payload.text;

            if (content) {
                turnCount++;
                const wordCount = content.trim().split(/\s+/).length;
                
                // הנוסחה: 1 נקודה בסיס + 1 על כל 50 מילים
                const baseCost = 1 + (wordCount / 50); 
                
                if (turn.source === 'system') {
                    totalScore += baseCost; // מחיר מלא לבוט
                } else if (turn.source === 'user') {
                    totalScore += (baseCost * 0.5); // 50% הנחה למשתמש
                }
            }
        }
    });

    const finalCalculatedCost = Math.ceil(totalScore);
    console.log(`📊 Transcript Analysis: ${turnCount} turns found. Calculated Value: ${finalCalculatedCost}`);

    // 3. בדיקת דלתא (האם יש חיוב חדש?)
    const { data: sessionRecord } = await supabase
        .from('processed_sessions')
        .select('charged_amount')
        .eq('session_id', session_id)
        .single();

    const alreadyPaid = sessionRecord ? sessionRecord.charged_amount : 0;
    const amountToChargeNow = finalCalculatedCost - alreadyPaid;

    if (amountToChargeNow <= 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: "No new charges" }) };
    }

    console.log(`💳 Processing Charge: ${amountToChargeNow} credits (User: ${user_id})`);

    // 4. ביצוע החיוב ב-Supabase
    const { data: userCredits } = await supabase
        .from('user_credits')
        .select('remaining_credits')
        .eq('user_id', user_id)
        .single();

    if (userCredits) {
        const newBalance = userCredits.remaining_credits - amountToChargeNow;
        
        // עדכון יתרה
        await supabase
            .from('user_credits')
            .update({ remaining_credits: newBalance })
            .eq('user_id', user_id);
            
        // תיעוד התשלום
        await supabase
            .from('processed_sessions')
            .upsert({ 
                session_id: session_id, 
                user_id: user_id, 
                charged_amount: finalCalculatedCost,
                last_sync: new Date().toISOString()
            }, { onConflict: 'session_id' });

        return { 
            statusCode: 200, 
            headers, 
            body: JSON.stringify({ success: true, charged: amountToChargeNow, new_balance: newBalance }) 
        };
    } else {
        return { statusCode: 404, headers, body: JSON.stringify({ error: "User not found" }) };
    }

  } catch (err) {
    console.error("🔥 System Error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
