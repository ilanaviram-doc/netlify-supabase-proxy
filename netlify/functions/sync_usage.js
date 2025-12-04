const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const VF_API_KEY = process.env.VOICEFLOW_API_KEY;
const VF_PROJECT_ID = '68d9462f0d7ce042ebb9af90';

// פונקציית החילוץ המעודכנת (לפי התגלית שלך!)
function extractText(payload) {
    if (!payload) return "";
    
    // 1. הזהב: השדה message שמכיל את הטקסט הנקי
    if (payload.message && typeof payload.message === 'string') {
        return payload.message;
    }
    
    // 2. בדיקות נוספות (למקרה שהפורמט משתנה)
    if (typeof payload === 'string') return payload;
    if (payload.text) return payload.text;
    
    // 3. חילוץ מתוך Slate (אם אין message)
    if (payload.slate && payload.slate.content) {
        try {
            return payload.slate.content
                .map(block => block.children ? block.children.map(c => c.text).join(' ') : '')
                .join(' ');
        } catch(e) { return ""; }
    }
    
    return "";
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { session_id, user_id } = JSON.parse(event.body);

    if (!session_id || !user_id) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing params" }) };

    console.log(`🔍 [SERVER] Checking Voiceflow for Session: ${session_id}`);

    // 1. חיפוש השיחה (Transcript)
    // אנחנו מבקשים את השיחה הכי חדשה של הסשן הזה
    const listUrl = `https://analytics-api.voiceflow.com/v1/transcripts?projectID=${VF_PROJECT_ID}&sessionID=${session_id}&sort=createdAt&limit=1`;
    
    const listResponse = await fetch(listUrl, { headers: { 'Authorization': VF_API_KEY } });

    if (!listResponse.ok) {
        if (listResponse.status === 404) {
            console.log("⏳ VF says: Transcript not ready yet (404). Will try again soon.");
            // מחזירים הצלחה כדי שהדפדפן לא יצעק שגיאות אדומות
            return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: "pending" }) };
        }
        console.log(`❌ Voiceflow API Error: ${listResponse.status}`);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, cost: 0 }) };
    }

    const listData = await listResponse.json();
    
    if (!listData || listData.length === 0) {
        console.log("⏳ No transcripts found in list.");
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: "pending" }) };
    }

    const transcriptID = listData[0]._id;
    console.log(`✅ Found Transcript ID: ${transcriptID}`);

    // 2. משיכת התוכן המלא
    const vfResponse = await fetch(`https://analytics-api.voiceflow.com/v1/transcript/${transcriptID}`, {
        headers: { 'Authorization': VF_API_KEY }
    });

    if (!vfResponse.ok) return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };

    const data = await vfResponse.json();
    const turns = data.transcript?.turns || [];

    // 3. חישוב עלויות (על בסיס הטקסט שחילצנו)
    let totalScore = 0;
    let turnCount = 0;

    turns.forEach(turn => {
        // בודקים סוגים רלוונטיים
        if (turn.type === 'text' || turn.type === 'speak' || turn.type === 'request') {
            
            // שימוש בפונקציה החדשה
            const content = extractText(turn.payload);

            if (content && content.trim().length > 0) {
                turnCount++;
                const wordCount = content.trim().split(/\s+/).length;
                
                // הנוסחה: 1 בסיס + 1 על כל 50 מילים
                const baseCost = 1 + Math.floor(wordCount / 50); 
                
                let itemCost = 0;
                if (turn.source === 'system') {
                    itemCost = baseCost;
                } else {
                    itemCost = (baseCost * 0.5); // הנחה למשתמש
                }
                
                totalScore += itemCost;
            }
        }
    });

    const finalCalculatedCost = Math.ceil(totalScore);
    console.log(`📊 Analysis: ${turnCount} turns found. Total Value: ${finalCalculatedCost} credits.`);

    // 4. חיוב (רק את ההפרש)
    const { data: sessionRecord } = await supabase
        .from('processed_sessions')
        .select('charged_amount')
        .eq('session_id', transcriptID)
        .single();

    const alreadyPaid = sessionRecord ? sessionRecord.charged_amount : 0;
    const amountToChargeNow = finalCalculatedCost - alreadyPaid;

    if (amountToChargeNow <= 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: "Up to date" }) };
    }

    console.log(`💳 CHARGING: ${amountToChargeNow} credits`);

    const { data: userCredits } = await supabase
        .from('user_credits')
        .select('remaining_credits')
        .eq('user_id', user_id)
        .single();

    if (userCredits) {
        const newBalance = userCredits.remaining_credits - amountToChargeNow;
        
        await supabase.from('user_credits').update({ remaining_credits: newBalance }).eq('user_id', user_id);
        
        await supabase.from('processed_sessions').upsert({ 
            session_id: transcriptID,
            user_id: user_id, 
            charged_amount: finalCalculatedCost,
            last_sync: new Date().toISOString()
        }, { onConflict: 'session_id' });

        return { statusCode: 200, headers, body: JSON.stringify({ success: true, charged: amountToChargeNow }) };
    } 
    
    return { statusCode: 404, headers, body: JSON.stringify({ error: "User not found" }) };

  } catch (err) {
    console.error("🔥 Server Error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
