const { createClient } = require('@supabase/supabase-js');

// הגדרת משתני סביבה - וודא שהם מוגדרים ב-Netlify Dashboard
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // חשוב: חייב להיות Service Role Key ולא Anon Key!

exports.handler = async (event, context) => {
  // 1. הגדרת כותרות CORS (כדי לאפשר גישה מהאתר שלך)
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // 2. טיפול בבקשת "בדיקה מקדימה" (Preflight/OPTIONS)
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  // 3. בדיקה שזו בקשת POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    // אתחול הקליינט
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // קריאת הנתונים שנשלחו מהדפדפן
    const { user_id, cost } = JSON.parse(event.body);

    if (!user_id) {
      throw new Error("Missing user_id");
    }

    // עלות ברירת מחדל = 1, אלא אם נשלח משהו אחר
    const deductionAmount = cost || 1;

    // שלב א': שליפת המאזן הנוכחי
    const { data: currentData, error: fetchError } = await supabase
      .from('user_credits')
      .select('remaining_credits')
      .eq('user_id', user_id)
      .single();

    if (fetchError || !currentData) {
      console.error('Error fetching credits:', fetchError);
      throw new Error("User credits not found");
    }

    const currentBalance = currentData.remaining_credits;
    
    // (אופציונלי: בדיקה אם נשאר קרדיט)
    // if (currentBalance < deductionAmount) { ... }

    // שלב ב': חישוב המאזן החדש
    const newBalance = currentBalance - deductionAmount;

    // שלב ג': עדכון בסיס הנתונים
    const { data: updatedData, error: updateError } = await supabase
      .from('user_credits')
      .update({ remaining_credits: newBalance })
      .eq('user_id', user_id)
      .select()
      .single();

    if (updateError) {
      console.error('Error updating credits:', updateError);
      throw new Error("Failed to update credits");
    }

    // 4. החזרת תשובה מוצלחת לדפדפן
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        new_balance: newBalance,
        previous_balance: currentBalance,
        deducted: deductionAmount
      })
    };

  } catch (error) {
    console.error("Function error:", error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};