// netlify/functions/deduct-credit.js (UPGRADED - Variable Cost)
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
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }
  
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { 
      statusCode: 405, 
      headers, 
      body: JSON.stringify({ error: 'Method Not Allowed' }) 
    };
  }
  
  try {
    // Parse request body
    const { user_id, cost } = JSON.parse(event.body);
    
    if (!user_id) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: 'Missing user_id' }) 
      };
    }
    
    // Default cost to 1 if not provided (backward compatibility)
    const creditsToDeduct = cost || 1;
    
    // Validate cost is a positive number
    if (typeof creditsToDeduct !== 'number' || creditsToDeduct <= 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid cost value' })
      };
    }
    
    console.log(`Deducting ${creditsToDeduct} credits for user ${user_id}`);
    
    // Connect to Supabase
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // Get current credits
    const { data: currentData, error: fetchError } = await supabase
      .from('user_credits')
      .select('remaining_credits')
      .eq('user_id', user_id)
      .single();
    
    if (fetchError) {
      console.error('Error fetching credits:', fetchError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to fetch credits' })
      };
    }
    
    const currentCredits = currentData.remaining_credits || 0;
    
    // Don't deduct if already at 0
    if (currentCredits <= 0) {
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
    
    // Deduct credits (but don't go below 0)
    const newCredits = Math.max(0, currentCredits - creditsToDeduct);
    const actualDeducted = currentCredits - newCredits;
    
    const { data: updateData, error: updateError } = await supabase
      .from('user_credits')
      .update({ remaining_credits: newCredits })
      .eq('user_id', user_id)
      .select();
    
    if (updateError) {
      console.error('Error updating credits:', updateError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to update credits' })
      };
    }
    
    console.log(`✅ Deducted ${actualDeducted} credits for user ${user_id}: ${currentCredits} → ${newCredits}`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true,
        new_balance: newCredits,
        previous_balance: currentCredits,
        deducted: actualDeducted,
        requested_cost: creditsToDeduct
      })
    };
    
  } catch (error) {
    console.error('Internal error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
