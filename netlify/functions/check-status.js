// netlify/functions/check-status.js (Updated for GET Request)
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  // 1. הגדרות CORS
  const headers = {
    'Access-Control-Allow-Origin': '*', // מאפשר לאתר שלך לגשת
    'Content-Type': 'application/json'
  };

  // אם הפונקציה מופעלת על ידי GET (כפי שקוד האתר שלך יעשה)
  if (event.httpMethod !== 'GET') {
    return { 
      statusCode: 405, 
      headers, 
      body: JSON.stringify({ error: 'Method Not Allowed' }) 
    };
  }

  try {
    // 2. קבלת user_id מפרמטרים של URL (Query String)
    const user_id = event.queryStringParameters.user_id;

    if (!user_id) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: 'Missing user_id parameter in URL' }) 
      };
    }

    // 3. התחברות ל-Supabase באמצעות משתני סביבה (כמו שהגדרת)
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; 
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 4. שאילתה ישירה לטבלה user_credits
    const { data, error } = await supabase
      .from('user_credits')
      .select('remaining_credits')
      .eq('user_id', user_id)
      .single();

    if (error && error.code !== 'PGRST116') throw error; // התעלם משגיאת "לא נמצא" (PGRST116)

    // 5. לוגיקה עסקית
    let credit_status = 'SUCCESS';
    let balance = (data && data.remaining_credits) ? data.remaining_credits : 0; // אם לא נמצא, היתרה היא 0

    if (balance <= 0) {
      credit_status = 'BLOCKED';
    } else if (balance < 100) {
      credit_status = 'WARNING';
    }

    // 6. החזרת התשובה לאתר שלך
    return {
      statusCode: 200, // תמיד מחזירים 200 כי הבדיקה הצליחה
      headers,
      body: JSON.stringify({ 
        status: credit_status, // האתר ישתמש בזה כדי לחסום/להציג אזהרה
        remaining_credits: balance 
      })
    };

  } catch (error) {
    console.error('Internal Function Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server error during credit check' })
    };
  }
};