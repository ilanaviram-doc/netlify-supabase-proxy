// netlify/functions/deduct-credit.js (תיקון - עובד עם user_subscriptions)
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  // CORS Headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  
  // Handle OPTIONS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { 
      statusCode: 405, 
      headers, 
      body: JSON.stringify({ error: 'Method Not Allowed' }) 
    };
  }
  
  console.log('--- deduct-credit function started (using user_subscriptions) ---');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) {
    console.error('SUPABASE_URL is not set!');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server config error: SUPABASE_URL not set' })
    };
  }
  if (!supabaseKey) {
    console.error('SUPABASE_SERVICE_ROLE_KEY is not set!');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server config error: SUPABASE_SERVICE_ROLE_KEY not set' })
    };
  }
  
  console.log('Supabase URL found (public part):', supabaseUrl.substring(0, 20) + '...');

  try {
    const { user_id, cost } = JSON.parse(event.body);
    
    if (!user_id) {
      console.error('Missing user_id in request');
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: 'Missing user_id' }) 
      };
    }
    
    const creditsToDeduct = cost || 1;
    
    if (typeof creditsToDeduct !== 'number' || creditsToDeduct <= 0) {
      console.error('Invalid cost value:', cost);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid cost value' })
      };
    }
    
    console.log(`Attempting to deduct ${creditsToDeduct} credits for user ${user_id}`);
    
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // 1. === התיקון === קריאה מהטבלה הנכונה
    const { data: currentData, error: fetchError } = await supabase
      .from('user_credits') // <-- תוקן
      .select('credits_remaining') // <-- תוקן
      .eq('user_id', user_id)
      .single();
    
    if (fetchError) {
      console.error('Error fetching credits from user_credits:', fetchError.message);
      throw new Error(`Failed to fetch credits: ${fetchError.message}`);
    }

    if (!currentData) {
      console.error(`No subscription record found for user: ${user_id}`);
      throw new Error(`No subscription record found for user: ${user_id}`);
    }
    
    const currentCredits = currentData.credits_remaining || 0; // <-- תוקן
    console.log(`User has ${currentCredits} credits`);
    
    if (currentCredits <= 0) {
      console.log('User already at 0 credits. No deduction.');
      // ... (הקוד להחזרת תשובה 0 זהה)
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          success: false,
          new_balance: 0,
          previous_balance: 0,
          deducted: 0,
          message: 'No credits remaining'
        })
      };
    }
    
    // Deduct credits
    const newCredits = Math.max(0, currentCredits - creditsToDeduct);
    const actualDeducted = currentCredits - newCredits;
    
    // 2. === התיקון === עדכון בטבלה הנכונה
    const { data: updateData, error: updateError } = await supabase
      .from('user_credits') // <-- תוקן
      .update({ credits_remaining: newCredits }) // <-- תוקן
      .eq('user_id', user_id)
      .select();
      
    if (updateError) {
      console.error('Error updating user_credits:', updateError.message);
      throw new Error(`Failed to update credits: ${updateError.message}`);
    }
    
    console.log(`✅ Deducted ${actualDeducted} credits for user ${user_id}: ${currentCredits} → ${newCredits}`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true,
        new_balance: newCredits,
        previous_balance: currentCredits,
        deducted: actualDeducted
      })
    };
    
  } catch (error) {
    // החזרת שגיאה לדפדפן
    console.error('Internal error:', error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: `Internal server error: ${error.message}` })
    };
  }
};