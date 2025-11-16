import { createClient } from '@supabase/supabase-js';

// משתני סביבה - ודא שהם מוגדרים ב-Netlify
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export const handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
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

  let data;
  try {
    data = JSON.parse(event.body);
  } catch (error) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Bad request: Invalid JSON body' })
    };
  }
  
  const { user_id, cost = 1 } = data; // Default cost to 1 if not provided

  if (!user_id) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Bad request: "user_id" is required' })
    };
  }

  try {
    // 1. Fetch current credits
    const { data: userData, error: fetchError } = await supabase
      .from('user_credits')
      .select('remaining_credits')
      .eq('user_id', user_id)
      .single();

    if (fetchError || !userData) {
      console.error('Failed to fetch user:', fetchError?.message);
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'User not found or fetch error' })
      };
    }

    const currentCredits = userData.remaining_credits;
    if (currentCredits <= 0) {
      return {
        statusCode: 402, // Payment Required
        headers,
        body: JSON.stringify({ error: 'No remaining credits', new_balance: 0 })
      };
    }

    // 2. Calculate new balance
    const newBalance = Math.max(0, currentCredits - cost); // Ensure it doesn't go below 0

    // 3. Update credits in database
    const { error: updateError } = await supabase
      .from('user_credits')
      .update({ remaining_credits: newBalance })
      .eq('user_id', user_id);

    if (updateError) {
      console.error('Failed to update credits:', updateError.message);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to update credits' })
      };
    }

    // 4. CRITICAL STEP: Return the new balance
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true, 
        new_balance: newBalance, // This is the field Voiceflow is capturing
        deducted: cost 
      })
    };

  } catch (error) {
    console.error('Internal server error:', error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: `Internal server error: ${error.message}` })
    };
  }
};