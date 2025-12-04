const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    // השרת מקבל מהדפדפן: "עד עכשיו השיחה עלתה X"
    const { session_id, user_id, current_total_cost } = JSON.parse(event.body);

    if (!session_id || !user_id || current_total_cost === undefined) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing params" }) };
    }

    console.log(`📥 Sync Request: User ${user_id}, Total Cost So Far: ${current_total_cost}`);

    // 1. בדיקה כמה כבר שולם על השיחה הזו
    const { data: sessionRecord } = await supabase
        .from('processed_sessions')
        .select('charged_amount')
        .eq('session_id', session_id)
        .single();

    const alreadyPaid = sessionRecord ? sessionRecord.charged_amount : 0;
    
    // 2. חישוב ההפרש לחיוב עכשיו
    const amountToChargeNow = current_total_cost - alreadyPaid;

    if (amountToChargeNow <= 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, charged: 0, message: "Up to date" }) };
    }

    console.log(`💳 CHARGING: ${amountToChargeNow} credits`);

    // 3. ביצוע החיוב
    const { data: userCredits } = await supabase
        .from('user_credits')
        .select('remaining_credits')
        .eq('user_id', user_id)
        .single();

    if (userCredits) {
        // בדיקת יתרה מספקת (אופציונלי - אפשר לתת להיכנס למינוס ולחסום אחר כך)
        const newBalance = userCredits.remaining_credits - amountToChargeNow;
        
        await supabase.from('user_credits').update({ remaining_credits: newBalance }).eq('user_id', user_id);
        
        await supabase.from('processed_sessions').upsert({ 
            session_id: session_id,
            user_id: user_id, 
            charged_amount: current_total_cost, // מעדכנים את הסך הכל החדש
            last_sync: new Date().toISOString()
        }, { onConflict: 'session_id' });

        return { statusCode: 200, headers, body: JSON.stringify({ success: true, charged: amountToChargeNow, new_balance: newBalance }) };
    } 
    
    return { statusCode: 404, headers, body: JSON.stringify({ error: "User not found" }) };

  } catch (err) {
    console.error("🔥 Error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
