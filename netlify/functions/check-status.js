// netlify/functions/check-status.js
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  // 1. הגדרות CORS (כדי ש-Voiceflow לא ייחסם)
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // טיפול בבקשות מקדימות (OPTIONS)
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // וידוא שזו בקשת POST
  if (event.httpMethod !== 'POST') {
    return { 
      statusCode: 405, 
      headers, 
      body: JSON.stringify({ error: 'Method Not Allowed' }) 
    };
  }

  try {
    // 2. קבלת פרטי התחברות ממשתני הסביבה
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // שימוש במפתח סודי להרשאה מלאה

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase environment variables');
    }

    // יצירת החיבור למסד הנתונים
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 3. קריאת ה-user_id מהבקשה של Voiceflow
    const body = JSON.parse(event.body);
    const user_id = body.user_id;

    if (!user_id) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: 'Missing user_id' }) 
      };
    }

    console.log(`Checking credits for user: ${user_id}`);

    // 4. שאילתה ישירה לטבלה user_credits
    const { data, error } = await supabase
      .from('user_credits')
      .select('remaining_credits')
      .eq('user_id', user_id)
      .single();

    if (error) {
      console.error('Supabase Error:', error);
      // אם השגיאה היא שלא נמצאה רשומה - נחזיר BLOCKED
      if (error.code === 'PGRST116') { // קוד שגיאה של "לא נמצא"
         return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ status: 'BLOCKED', new_balance: 0 })
         };
      }
      throw error;
    }

    // 5. לוגיקה עסקית (בדיקת יתרה)
    let credit_status = 'SUCCESS';
    let balance = data.remaining_credits;

    if (balance <= 0) {
      credit_status = 'BLOCKED';
    } else if (balance < 100) {
      credit_status = 'WARNING';
    }

    // 6. החזרת התשובה ל-Voiceflow
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        status: credit_status, 
        new_balance: balance 
      })
    };

  } catch (error) {
    console.error('Internal Function Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};