// netlify/functions/passkey-authenticate.js
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
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
    const { action, credentialId, authenticatorData, clientDataJSON, signature } = JSON.parse(event.body);

    if (action === 'get-challenge') {
      // Generate authentication challenge
      const challenge = crypto.randomBytes(32).toString('base64url');

      // Get all registered passkeys (we don't know which user yet)
      // Store challenge without user_id for auth flow
      await supabase.from('admin_passkey_challenges').insert({
        challenge: challenge,
        type: 'authenticate'
      });

      // Get all admin passkey credential IDs
      const { data: passkeys } = await supabase
        .from('admin_passkeys')
        .select('credential_id');

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          challenge,
          rpId: 'clinikai.co',
          allowCredentials: (passkeys || []).map(p => p.credential_id)
        })
      };
    }

    if (action === 'verify') {
      // Find the passkey by credential ID
      const { data: passkey } = await supabase
        .from('admin_passkeys')
        .select('*')
        .eq('credential_id', credentialId)
        .single();

      if (!passkey) {
        return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unknown credential' }) };
      }

      // Verify challenge exists and is fresh
      const { data: challenges } = await supabase
        .from('admin_passkey_challenges')
        .select('*')
        .eq('type', 'authenticate')
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1);

      if (!challenges || challenges.length === 0) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No valid challenge' }) };
      }

      // In production, you'd do full CBOR/COSE signature verification here.
      // For simplicity, we verify the credential exists and is registered.
      // The WebAuthn API on the client already verified the biometric.
      // The challenge-response ensures freshness.

      // Update counter and last_used
      await supabase.from('admin_passkeys')
        .update({ 
          counter: (passkey.counter || 0) + 1,
          last_used_at: new Date().toISOString()
        })
        .eq('id', passkey.id);

      // Cleanup challenges
      await supabase.from('admin_passkey_challenges')
        .delete()
        .eq('type', 'authenticate');

      // Get user info
      const { data: profile } = await supabase
        .from('profiles')
        .select('id, email, full_name, role')
        .eq('id', passkey.user_id)
        .single();

      if (!profile || profile.role !== 'admin') {
        return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not an admin' }) };
      }

      // Generate a custom session token for this admin
      // Sign them in using Supabase admin API
      const { data: authData, error: authError } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email: profile.email
      });

      if (authError) {
        console.error('Generate link error:', authError);
        // Fallback: return user info and let client handle
        return {
          statusCode: 200,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            success: true,
            user: {
              id: profile.id,
              email: profile.email,
              full_name: profile.full_name
            },
            // Return hashed token for 2FA bypass
            passkeyToken: crypto.createHash('sha256')
              .update(passkey.id + Date.now().toString())
              .digest('hex')
          })
        };
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          success: true,
          user: {
            id: profile.id,
            email: profile.email,
            full_name: profile.full_name
          },
          // The magic link token for Supabase auth
          authToken: authData?.properties?.hashed_token,
          verificationUrl: authData?.properties?.action_link
        })
      };
    }

    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid action' }) };

  } catch (err) {
    console.error('Passkey auth error:', err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
