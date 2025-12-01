const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  console.log("📨 New request received");

  try {
    // קריאת Body
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      console.error("❌ Failed to parse body:", e.message);
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: "Invalid JSON body" }) 
      };
    }

    console.log(`✅ Parsed body: ${JSON.stringify(body)}`);

    let user_id = body.user_id;
    const cost = parseInt(body.cost) || 1;

    console.log(`🔍 Original user_id: "${user_id}"`);

    // ניקוי user_id - הסרת רווחים מיותרים
    if (user_id) {
      user_id = user_id.toString().trim();
    }

    console.log(`🧹 Cleaned user_id: "${user_id}"`);

    // בדיקת תקינות מורחבת
    const invalidValues = ['0', 'null', 'undefined', '', 'ANONYMOUS'];
    const hasInvalidChars = user_id && (user_id.includes('{') || user_id.includes('}'));
    
    if (!user_id || 
        invalidValues.includes(user_id) || 
        hasInvalidChars ||
        user_id.length < 10) {  // UUID צריך להיות לפחות 10 תווים
      
      console.error(`❌ Invalid user_id detected: "${user_id}"`);
      
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ 
          error: "Invalid user_id",
          received: user_id,
          hint: "user_id must be a valid UUID from Supabase Auth"
        }) 
      };
    }

    console.log(`💳 Processing deduction: User="${user_id}", Cost=${cost}`);

    // חיפוש המשתמש בSupabase
    console.log(`🔍 Looking up user in database: "${user_id}"`);
    
    const { data: userRecord, error: fetchError } = await supabase
      .from('user_credits')
      .select('remaining_credits')
      .eq('user_id', user_id)
      .single();

    if (fetchError || !userRecord) {
      console.error(`❌ User not found in database!`);
      console.error(`user_id: ${user_id}`);
      
      return { 
        statusCode: 404, 
        headers, 
        body: JSON.stringify({ 
          error: "User not found in database",
          user_id: user_id,
          message: "This user must register on the website first"
        }) 
      };
    }

    const currentBalance = userRecord.remaining_credits;
    console.log(`📊 Current balance: ${currentBalance}`);

    // בדיקת יתרה
    if (currentBalance <= 0) {
      console.warn(`⚠️ Insufficient credits for user: ${user_id}`);
      
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: "Insufficient credits",
          current_balance: 0,
          message: "Please purchase more credits to continue"
        })
      };
    }

    // חישוב יתרה חדשה
    const newBalance = Math.max(0, currentBalance - cost);
    console.log(`➖ Deducting: ${cost}`);
    console.log(`📊 New balance: ${newBalance}`);

    // עדכון בdatabase
    const { error: updateError } = await supabase
      .from('user_credits')
      .update({ remaining_credits: newBalance })
      .eq('user_id', user_id);

    if (updateError) {
      console.error(`❌ Database update failed: ${updateError.message}`);
      
      return { 
        statusCode: 500, 
        headers, 
        body: JSON.stringify({ 
          error: "Failed to update credits in database",
          details: updateError.message
        }) 
      };
    }

    console.log(`✅✅✅ SUCCESS! Credits deducted successfully!`);
    console.log(`User: ${user_id} | ${currentBalance} → ${newBalance}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true, 
        new_balance: newBalance,
        old_balance: currentBalance,
        cost_deducted: cost,
        user_id: user_id
      })
    };

  } catch (err) {
    console.error(`🔥 CRITICAL ERROR: ${err.message}`);
    console.error(err.stack);
    
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ 
        error: "Internal server error",
        message: err.message
      }) 
    };
  }
};