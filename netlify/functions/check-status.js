// netlify/functions/check-status.js (FIXED for CORS)
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  // 1. CORS Headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };
  
  // 2. Handle OPTIONS preflight request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }
  
  // 3. Handle GET request
  if (event.httpMethod !== 'GET') {
    return { 
      statusCode: 405, 
      headers, 
      body: JSON.stringify({ error: 'Method Not Allowed' }) 
    };
  }
  
  try {
    // 4. Get user_id from query parameters
    const user_id = event.queryStringParameters.user_id;
    if (!user_id) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: 'Missing user_id parameter in URL' }) 
      };
    }
    
    // 5. Connect to Supabase
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; 
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // 6. Query user_credits table
    const { data, error } = await supabase
      .from('user_credits')
      .select('remaining_credits')
      .eq('user_id', user_id)
      .single();
    
    if (error && error.code !== 'PGRST116') throw error;
    
    // 7. Business logic
    let credit_status = 'SUCCESS';
    let balance = (data && data.remaining_credits) ? data.remaining_credits : 0;
    
    if (balance <= 0) {
      credit_status = 'BLOCKED';
    } else if (balance < 100) {
      credit_status = 'WARNING';
    }
    
    // 8. Return response
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        status: credit_status,
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
