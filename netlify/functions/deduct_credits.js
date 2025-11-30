import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export const handler = async (event) => {
  // כותרות CORS (חשוב לתקשורת עם Voiceflow)
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const body = JSON.parse(event.body);
    // לוג לבדיקה: מה בדיוק הגיע מ-Voiceflow?
    console.log("🔍 Incoming Request Body:", body);

    const { user_id, cost } = body;
    const deduction = cost || 1;

    if (!user_id) {
      console.error("❌ Error: user_id is missing");
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing user_id" }) };
    }

    // 1. נסיון לשלוף את המשתמש לפי הטבלה שבתמונה שלך
    let { data: userRecord, error: fetchError } = await supabase
      .from('user_credits')
      .select('*')
      .eq('user_id', user_id) // תואם לעמודה בתמונה
      .single();

    // 2. אם המשתמש לא קיים בטבלה - ניצור אותו (Upsert)
    if (fetchError || !userRecord) {
      console.log(`⚠️ User ${user_id} not found in credits table. Creating new record...`);
      
      const { data: newRecord, error: insertError } = await supabase
        .from('user_credits')
        .insert([
          { user_id: user_id, remaining_credits: 50 } // נותן 50 מתנה למשתמש חדש
        ])
        .select()
        .single();

      if (insertError) {
        console.error("❌ Failed to create user:", insertError);
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Failed to create user record", details: insertError }) };
      }
      userRecord = newRecord;
    }

    // 3. בדיקה אם נשארו קרדיטים
    if (userRecord.remaining_credits < deduction) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ success: false, message: "Not enough credits", new_balance: userRecord.remaining_credits })
      };
    }

    // 4. ביצוע ההפחתה (Update)
    const newBalance = userRecord.remaining_credits - deduction;
    
    const { data: updateData, error: updateError } = await supabase
      .from('user_credits')
      .update({ remaining_credits: newBalance }) // תואם לעמודה בתמונה
      .eq('user_id', user_id)
      .select()
      .single();

    if (updateError) throw updateError;

    console.log(`✅ Success! New balance for ${user_id}: ${newBalance}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        new_balance: newBalance,
        deducted: deduction
      })
    };

  } catch (error) {
    console.error("🔥 System Error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};