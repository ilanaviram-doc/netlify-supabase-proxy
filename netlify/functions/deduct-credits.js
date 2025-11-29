import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export const handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-User-ID, X-Voiceflow-User-ID',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight OPTIONS request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ message: 'OPTIONS request handled' })
    };
  }

  // Handle POST request
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    console.log('🔍 Incoming request headers:', JSON.stringify(event.headers, null, 2));
    console.log('🔍 Incoming request body:', event.body);

    // ✅ קבלת user_id מ-3 מקורות אפשריים
    let user_id = null;
    
    // אופציה 1: מ-Voiceflow headers (אוטומטי!)
    if (event.headers['x-voiceflow-user-id']) {
      user_id = event.headers['x-voiceflow-user-id'];
      console.log('✅ Got userID from x-voiceflow-user-id header:', user_id);
    }
    
    // אופציה 2: מ-custom header
    if (!user_id && event.headers['x-user-id']) {
      user_id = event.headers['x-user-id'];
      console.log('✅ Got userID from x-user-id header:', user_id);
    }
    
    // אופציה 3: מה-body (fallback)
    if (!user_id && event.body) {
      try {
        const body = JSON.parse(event.body);
        user_id = body.user_id;
        console.log('✅ Got userID from body:', user_id);
      } catch (e) {
        console.error('❌ Failed to parse body:', e);
      }
    }

    // קבלת cost מה-body
    let cost = 1; // default
    if (event.body) {
      try {
        const body = JSON.parse(event.body);
        cost = body.cost || 1;
      } catch (e) {
        console.error('❌ Failed to parse cost from body:', e);
      }
    }

    console.log('📊 Final userID:', user_id);
    console.log('📊 Cost:', cost);

    // בדיקה שיש user_id
    if (!user_id) {
      console.error('❌ No user_id found!');
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'user_id is required',
          debug: {
            headers: event.headers,
            body: event.body
          }
        })
      };
    }

    // Validation של UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(user_id)) {
      console.error('❌ Invalid UUID format:', user_id);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'Invalid user_id format. Expected UUID.',
          received: user_id
        })
      };
    }

    // שליפת הקרדיטים הנוכחיים
    console.log('🔍 Fetching current credits for user:', user_id);
    const { data: currentData, error: fetchError } = await supabase
      .from('user_credits')
      .select('remaining_credits')
      .eq('user_id', user_id)
      .single();

    if (fetchError) {
      console.error('❌ Fetch error:', fetchError);
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ 
          error: 'User not found or fetch error',
          details: fetchError.message 
        })
      };
    }

    if (!currentData) {
      console.error('❌ No data found for user:', user_id);
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ 
          error: 'User not found in user_credits table'
        })
      };
    }

    const previousBalance = currentData.remaining_credits;
    const newBalance = Math.max(0, previousBalance - cost);

    console.log(`💳 Deducting ${cost} credits: ${previousBalance} → ${newBalance}`);

    // עדכון הקרדיטים
    const { error: updateError } = await supabase
      .from('user_credits')
      .update({ remaining_credits: newBalance })
      .eq('user_id', user_id);

    if (updateError) {
      console.error('❌ Update error:', updateError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          error: 'Failed to update credits',
          details: updateError.message 
        })
      };
    }

    console.log('✅ Credits deducted successfully!');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        previous_balance: previousBalance,
        deducted: cost,
        new_balance: newBalance
      })
    };

  } catch (err) {
    console.error('❌ Unexpected error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Internal server error',
        message: err.message,
        stack: err.stack
      })
    };
  }
};