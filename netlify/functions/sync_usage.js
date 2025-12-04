const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const VF_API_KEY = process.env.VOICEFLOW_API_KEY;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { session_id, user_id } = JSON.parse(event.body);

    if (!session_id || !user_id) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing parameters" }) };

    // 1. קריאה ל-Voiceflow
    const vfResponse = await fetch(`https://analytics-api.voiceflow.com/v1/transcript/${session_id}`, {
        headers: { 'Authorization': VF_API_KEY }
    });

    if (!vfResponse.ok) {
        console.log(`⚠️ Transcript not ready yet for session: ${session_id}`);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, cost: 0 }) };
    }

    const data = await vfResponse.json();
    
    // === דיבוג: הדפסת המבנה כדי לראות מה אנחנו מפספסים ===
    // (הלוג הזה יופיע ב-Netlify ויגלה לנו את האמת)
    // console.log("🔍 Full Transcript Data:", JSON.stringify(data).substring(0, 500)); // רק ההתחלה כדי לא להציף

    const turns = data.transcript || []; // לפעמים זה מערך ישיר ולפעמים בתוך אובייקט

    // 2. חישוב עלויות
    let totalScore = 0;
    let turnCount = 0;

    // התאמה למבנה החדש של ה-API
    const turnsArray = Array.isArray(turns) ? turns : (data.transcript?.turns || []);

    turnsArray.forEach(turn => {
        // בדיקת סוג הצעד (text, speak, visuals)
        if (turn.type === 'text' || turn.type === 'speak') {
            
            let content = "";
            // ניסיון חילוץ מכל מקום אפשרי
            if (typeof turn.payload === 'string') content = turn.payload;
            else if (turn.payload?.text) content = turn.payload.text;
            else if (turn.payload?.message) content = turn.payload.message; // לפעמים זה message
            else if (turn.payload?.payload?.text) content = turn.payload.payload.text;

            if (content) {
                turnCount++;
                const wordCount = content.trim().split(/\s+/).length;
                const baseCost = 1 + (wordCount / 50); 
                
                if (turn.source === 'system') {
                    totalScore += baseCost;
                } else if (turn.source === 'user') {
                    totalScore += (baseCost * 0.5);
                }
            }
        }
    });

    const finalCalculatedCost = Math.ceil(totalScore);
    console.log(`📊 Analysis: Found ${turnCount} text turns. Total Score: ${finalCalculatedCost}`);

    // 3. חיוב
    const { data: sessionRecord } = await supabase
        .from('processed_sessions')
        .select('charged_amount')
        .eq('session_id', session_id)
        .single();

    const alreadyPaid = sessionRecord ? sessionRecord.charged_amount : 0;
    const amountToChargeNow = finalCalculatedCost - alreadyPaid;

    if (amountToChargeNow <= 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: "No new charges", total: finalCalculatedCost }) };
    }

    console.log(`💳 CHARGING: ${amountToChargeNow} credits (User: ${user_id})`);

    // 4. עדכון DB
    const { data: userCredits } = await supabase
        .from('user_credits')
        .select('remaining_credits')
        .eq('user_id', user_id)
        .single();

    if (userCredits) {
        const newBalance = userCredits.remaining_credits - amountToChargeNow;
        
        await supabase.from('user_credits').update({ remaining_credits: newBalance }).eq('user_id', user_id);
        
        await supabase.from('processed_sessions').upsert({ 
            session_id: session_id, 
            user_id: user_id, 
            charged_amount: finalCalculatedCost,
            last_sync: new Date().toISOString()
        }, { onConflict: 'session_id' });

        return { statusCode: 200, headers, body: JSON.stringify({ success: true, charged: amountToChargeNow }) };
    } 
    
    return { statusCode: 400, headers, body: JSON.stringify({ error: "User not found" }) };

  } catch (err) {
    console.error("Sync Error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
