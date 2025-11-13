// netlify/functions/check-status.js
// קוד זה מעביר את הבקשה כפי שהיא ל-Supabase Edge Function,
// ומונע את ניסיון האימות מתוך ה-Proxy.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: 'Method Not Allowed'
    };
  }

  // 1. הגדרת ה-URL של הפונקציה ב-Supabase
  // אנא ודא שה-URL הזה נכון! זהו ה-URL המקורי שלך.
  const SUPABASE_FUNCTION_URL = 'https://rmgtegimphjpzxcflotn.supabase.co/functions/v1/check-status-v2';

  // 2. העתקת כותרות הבקשה (כולל ה-Anon Key)
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': event.headers.authorization, // מעביר את ה-Bearer <Anon Key> כפי שהוא
  };

  try {
    const response = await fetch(SUPABASE_FUNCTION_URL, {
      method: 'POST',
      headers: headers,
      body: event.body, // מעביר את גוף הבקשה (ה-JSON)
    });

    const data = await response.json();

    return {
      statusCode: response.status,
      body: JSON.stringify(data),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Proxy failed to connect to Supabase.', details: error.message }),
    };
  }
};