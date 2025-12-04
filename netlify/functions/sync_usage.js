const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const VF_API_KEY = process.env.VOICEFLOW_API_KEY;

exports.handler = async (event) => {
  // CORS Headers
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

    // 1. משיכת התמליל המלא מ-Voiceflow
    const vfResponse = await fetch(`https://analytics-api.voiceflow.com/v1/transcript/${session_id}`, {
        headers: { 'Authorization': VF_API_KEY }
    });

    if (!vfResponse.ok) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, cost: 0, note: "Transcript not ready" }) };
    }

    const data = await vfResponse.json();
    const turns = data.transcript?.turns || [];

    // 2. חישוב עלות מצטבר (כולל משתמש ב-50% הנחה)
    let totalScore = 0; // משתמשים בנקודות (float) ומעגלים בסוף

    turns.forEach(turn => {
        // אנחנו בודקים רק הודעות טקסט (של המשתמש או של הבוט)
        if (turn.type === 'text') {
            
            // חילוץ הטקסט (מטפל במבנים שונים של VF)
            let content = "";
            if (typeof turn.payload === 'string') content = turn.payload;
            else if (turn.payload?.text) content = turn.payload.text;
            else if (turn.payload?.payload?.text) content = turn.payload.payload.text;

            if (content) {
                // חישוב מילים
                const wordCount = content.trim().split(/\s+/).length;
                
                // חישוב עלות בסיסית להודעה זו (לפני הנחה)
                // 1 קרדיט בסיס + 1 על כל 50 מילים
                const baseCost = 1 + (wordCount / 50); 
                
                if (turn.source === 'system') {
                    // === תור של הבוט: מחיר מלא ===
                    totalScore += baseCost;
                    // console.log(`🤖 AI: ${wordCount} words = ${baseCost.toFixed(2)} pts`);
                } 
                else if (turn.source === 'user') {
                    // === תור של המשתמש: 50% הנחה ===
                    const userCost = baseCost * 0.5;
                    totalScore += userCost;
                    // console.log(`👤 User: ${wordCount} words = ${userCost.toFixed(2)} pts`);
                }
            }
        }
    });

    // עיגול כלפי מעלה למספר שלם (כדי לשמור ב-DB)
    const finalCalculatedCost = Math.ceil(totalScore);

    // 3. חישוב ה"דלתא" (כמה צריך לחייב עכשיו - ההפרש ממה שכבר חויב)
    const { data: sessionRecord } = await supabase
        .from('processed_sessions')
        .select('charged_amount')
        .eq('session_id', session_id)
        .single();

    const alreadyPaid = sessionRecord ? sessionRecord.charged_amount : 0;
    const amountToChargeNow = finalCalculatedCost - alreadyPaid;

    // אם אין חיוב חדש (או שהחישוב יצא שלילי/אפס) - סיים
    if (amountToChargeNow <= 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: "No new charges" }) };
    }

    console.log(`💳 Charge: ${amountToChargeNow} credits (Total Session Value: ${finalCalculatedCost})`);

    // 4. ביצוע החיוב במסד הנתונים
    
    // א. בדיקת יתרה נוכחית
    const { data: userCredits, error: fetchError } = await supabase
        .from('user_credits')
        .select('remaining_credits')
        .eq('user_id', user_id)
        .single();

    if (fetchError || !userCredits) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: "User credits not found" }) };
    }

    // ב. עדכון היתרה
    const newBalance = userCredits.remaining_credits - amountToChargeNow;
    await supabase
        .from('user_credits')
        .update({ remaining_credits: newBalance })
        .eq('user_id', user_id);
            
    // ג. תיעוד התשלום בטבלת הסשנים (כדי שלא נחייב שוב על אותו חלק)
    await supabase
        .from('processed_sessions')
        .upsert({ 
            session_id: session_id, 
            user_id: user_id, 
            charged_amount: finalCalculatedCost, // שומרים את הסך הכל החדש (מספר שלם)
            last_sync: new Date().toISOString()
        }, { onConflict: 'session_id' });

    return { 
        statusCode: 200, 
        headers, 
        body: JSON.stringify({ success: true, charged: amountToChargeNow, new_balance: newBalance }) 
    };

  } catch (err) {
    console.error("Sync Error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
