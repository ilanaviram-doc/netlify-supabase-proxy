// netlify/functions/passkey-register.js
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { action, userId, credential, deviceName } = JSON.parse(event.body);

    // Verify the user is an admin
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .single();

    if (!profile || profile.role !== 'admin') {
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not authorized' }) };
    }

    if (action === 'get-challenge') {
      // Generate registration challenge
      const challenge = crypto.randomBytes(32).toString('base64url');

      // Store challenge in DB
      await supabase.from('admin_passkey_challenges').insert({
        user_id: userId,
        challenge: challenge,
        type: 'register'
      });

      // Get existing credentials to exclude
      const { data: existing } = await supabase
        .from('admin_passkeys')
        .select('credential_id')
        .eq('user_id', userId);

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          challenge,
          rpId: 'clinikai.co',
          rpName: 'ClinikAI Admin',
          userId: userId,
          excludeCredentials: (existing || []).map(c => c.credential_id)
        })
      };
    }

    if (action === 'store-credential') {
      // Verify the challenge exists and is fresh
      const { data: challenges } = await supabase
        .from('admin_passkey_challenges')
        .select('*')
        .eq('user_id', userId)
        .eq('type', 'register')
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1);

      if (!challenges || challenges.length === 0) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No valid challenge found' }) };
      }

      // Store the credential
      const { error } = await supabase.from('admin_passkeys').insert({
        user_id: userId,
        credential_id: credential.id,
        public_key: credential.publicKey,
        counter: credential.counter || 0,
        device_name: deviceName || 'Mobile Device'
      });

      if (error) {
        console.error('Store credential error:', error);
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to store credential' }) };
      }

      // Cleanup challenge
      await supabase.from('admin_passkey_challenges')
        .delete()
        .eq('user_id', userId)
        .eq('type', 'register');

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: true })
      };
    }

    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid action' }) };

  } catch (err) {
    console.error('Passkey register error:', err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
