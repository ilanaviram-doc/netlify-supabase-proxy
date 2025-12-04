const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
  // CORS Headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    // השרת מקבל דיווח מהאתר: "סך העלות עד עכשיו היא X"
    const { session_id, user_id, total_cost_so_far } = JSON.parse(event.body);

    if (!session_id || !user_id || total_cost_so_far === undefined) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing data" }) };
    }

    // === כאן הלוגים שרצית! ===
    console.log(`📥 REPORT RECEIVED: Session ${session_id}`);
    console.log(`💰 Client reports total value: ${total_cost_so_far} credits`);

    // 1. בדיקה במסד הנתונים
    const { data: sessionRecord } = await supabase
        .from('processed_sessions')
        .select('charged_amount')
        .eq('session_id', session_id)
        .single();

    const alreadyPaid = sessionRecord ? sessionRecord.charged_amount : 0;
    
    // 2. חישוב ההפרש
    const amountToCharge = total_cost_so_far - alreadyPaid;

    if (amountToCharge <= 0) {
        console.log(`✅ Log: No new charges. (Total: ${total_cost_so_far}, Paid: ${alreadyPaid})`);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, charged: 0 }) };
    }

    console.log(`💳 CHARGING NOW: ${amountToCharge} credits`);

    // 3. ביצוע החיוב
    const { data: userCredits } = await supabase
        .from('user_credits')
        .select('remaining_credits')
        .eq('user_id', user_id)
        .single();

    if (userCredits) {
        const newBalance = userCredits.remaining_credits - amountToCharge;
        
        await supabase.from('user_credits').update({ remaining_credits: newBalance }).eq('user_id', user_id);
        
        await supabase.from('processed_sessions').upsert({ 
            session_id: session_id,
            user_id: user_id, 
            charged_amount: total_cost_so_far,
            last_sync: new Date().toISOString()
        }, { onConflict: 'session_id' });

        console.log(`✅ Success! New Balance: ${newBalance}`);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, charged: amountToCharge }) };
    } 
    
    return { statusCode: 404, headers, body: JSON.stringify({ error: "User not found" }) };

  } catch (err) {
    console.error("🔥 Server Error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
