const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const VF_API_KEY = process.env.VOICEFLOW_API_KEY;
const VF_PROJECT_ID = '68d9462f0d7ce042ebb9af90';

// === 🛡️ System Message Patterns (לא לחייב!) ===
const SYSTEM_MESSAGE_PATTERNS = [
    // הודעות פתיחה וברכה
    'שלום', 'ברוכים הבאים', 'ברוך הבא', 'ברוכה הבאה',
    'היי', 'hello', 'welcome', 'hi there',
    // הודעות חזרה אחרי אי פעילות
    'חזרת', 'שמחים לראותך', 'ברוכים השבים', 'טוב שחזרת',
    'לא היית פעיל', 'עבר זמן', 'הרבה זמן',
    // הודעות מערכת כלליות
    'איך אפשר לעזור', 'במה אוכל לעזור', 'מה תרצה',
    'בחר אפשרות', 'בחרי אפשרות', 'לחץ על', 'לחצי על',
    // הודעות סיום
    'להתראות', 'ביי', 'תודה שפנית', 'נשמח לעזור שוב'
];

// === 🛡️ Button Response Patterns (לא לחייב!) ===
const BUTTON_RESPONSE_PATTERNS = [
    'כן', 'לא', 'אישור', 'ביטול', 'סגור', 'המשך',
    'הבא', 'חזור', 'התחל', 'סיים', 'שלח', 'אשר',
    'ok', 'yes', 'no', 'cancel', 'start', 'continue',
    'back', 'next', 'done', 'submit'
];

// === 🛡️ Check if message is a system message ===
function isSystemMessage(content, logType) {
    if (!content || content.length === 0) return { skip: true, cost: 0 };
    
    const contentLower = content.toLowerCase().trim();
    
    // 1. הודעות משתמש קצרות מאוד (< 5 תווים) = כפתור = חינם!
    if (logType === 'action' && contentLower.length < 5) {
        console.log(`🆓 FREE: Very short user message (${contentLower.length} chars)`);
        return { skip: true, cost: 0 };
    }
    
    // 2. לחיצות על כפתורים = חינם!
    if (logType === 'action' && contentLower.length <= 15) {
        for (const pattern of BUTTON_RESPONSE_PATTERNS) {
            if (contentLower === pattern.toLowerCase() || contentLower.includes(pattern.toLowerCase())) {
                console.log(`🆓 FREE: Button click ("${content}")`);
                return { skip: true, cost: 0 };
            }
        }
    }
    
    // 3. הודעות בוט קצרות (< 50 תווים) = 1 קרדיט
    if (logType === 'trace' && contentLower.length < 50) {
        console.log(`💰 SYSTEM: Short bot message (${contentLower.length} chars) = 1 credit`);
        return { skip: false, cost: 1 };
    }
    
    // 4. הודעות מערכת (שלום, ברוכים הבאים) = 1 קרדיט
    if (logType === 'trace') {
        for (const pattern of SYSTEM_MESSAGE_PATTERNS) {
            if (contentLower.includes(pattern.toLowerCase())) {
                console.log(`💰 SYSTEM: "${pattern}" = 1 credit`);
                return { skip: false, cost: 1 };
            }
        }
    }
    
    // 5. הודעה רגילה = חישוב מלא
    return { skip: false, cost: null };
}

// === Extraction Logic based on "Logs" structure ===
function extractTextFromLog(log) {
    try {
        // 1. System/Bot Messages (Type: "trace")
        if (log.type === 'trace' && log.data && log.data.payload) {
            if (log.data.payload.message) return log.data.payload.message;
            if (log.data.payload.slate) return JSON.stringify(log.data.payload.slate);
        }

        // 2. User Messages (Type: "action")
        if (log.type === 'action' && log.data && log.data.payload) {
            if (log.data.payload.payload && typeof log.data.payload.payload === 'string') {
                return log.data.payload.payload;
            }
            if (typeof log.data.payload === 'string') return log.data.payload;
        }
    } catch (e) { return ""; }
    
    return "";
}

// === 🆕 Log credit transaction to database ===
async function logCreditTransaction(params) {
    const {
        user_id,
        user_email,
        amount,
        balance_before,
        balance_after,
        session_id,
        transaction_type = 'deduction',
        source = 'voiceflow',
        description = null,
        metadata = null
    } = params;

    try {
        const { error } = await supabase
            .from('credit_logs')
            .insert({
                user_id,
                user_email,
                amount: -Math.abs(amount), // Always negative for deductions
                transaction_type,
                balance_before,
                balance_after,
                source,
                voiceflow_session_id: session_id,
                description,
                metadata
            });

        if (error) {
            console.error('❌ Failed to log credit transaction:', error.message);
        } else {
            console.log(`📝 Logged: ${amount} credits deducted from ${user_email}`);
        }
    } catch (err) {
        console.error('❌ Error logging transaction:', err.message);
    }
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

    console.log(`🔍 [SERVER] Syncing for UserID: ${session_id}`);

    // 1. Search for Transcript (POST)
    const searchUrl = `https://analytics-api.voiceflow.com/v1/transcript/project/${VF_PROJECT_ID}`;
    const searchResponse = await fetch(searchUrl, { 
        method: 'POST', 
        headers: { 
            'authorization': VF_API_KEY, 
            'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ sessionID: session_id })
    });

    if (!searchResponse.ok) {
        console.log(`❌ Search Error: ${searchResponse.status}`);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: "pending_search" }) };
    }

    const searchResult = await searchResponse.json();
    const transcriptsList = searchResult.transcripts || [];

    if (transcriptsList.length === 0) {
        console.log("⏳ VF: No transcripts found yet.");
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: "pending_index" }) };
    }

    // Get the latest transcript
    transcriptsList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const transcriptID = transcriptsList[0]._id || transcriptsList[0].id;
    console.log(`✅ Found Transcript ID: ${transcriptID}`);

    // ==================================================================
    // 2. Get Full Details (CRITICAL FIX: filterConversation=false)
    // ==================================================================
    const detailUrl = `https://analytics-api.voiceflow.com/v1/transcript/${transcriptID}?filterConversation=false`;
    
    const detailResponse = await fetch(detailUrl, { 
        headers: { 'authorization': VF_API_KEY } 
    });

    if (!detailResponse.ok) return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };

    const data = await detailResponse.json();

    const logs = data.transcript?.logs || []; 

    console.log(`🐛 Raw Logs Found: ${logs.length}`);

    // ============================================================
    // 3. Calculate Costs - 20 words = 1 credit + system messages = 1 credit
    // ============================================================
    let totalScore = 0;
    let turnCount = 0;
    let freeCount = 0;
    let systemCount = 0;
    let totalWordCount = 0; // 🆕 Track total words

    logs.forEach(log => {
        const content = extractTextFromLog(log);
        
        if (content && content.length > 1) { 
            
            const messageCheck = isSystemMessage(content, log.type);
            
            if (messageCheck.skip) {
                freeCount++;
                return;
            }
            
            if (messageCheck.cost === 1) {
                systemCount++;
                totalScore += 1;
                return;
            }
            
            turnCount++;
            const wordCount = content.trim().split(/\s+/).length;
            totalWordCount += wordCount; // 🆕 Accumulate
            
            const baseCost = Math.max(1, Math.ceil(wordCount / 20));
            
            console.log(`💰 Cost calc: ${wordCount} words = ${baseCost} credits`);
            
            let itemCost = 0;
            if (log.type === 'trace') {
                itemCost = baseCost;
            } else if (log.type === 'action') {
                itemCost = Math.ceil(baseCost * 0.5); 
            }
            
            totalScore += itemCost;
        }
    });

    const finalCalculatedCost = Math.ceil(totalScore);
    console.log(`📊 Analysis: ${turnCount} paid + ${systemCount} system (1 each) + ${freeCount} free. Total: ${finalCalculatedCost}`);

    // 4. Check what's already been charged
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

    // 5. Get user info and current balance
    const { data: userCredits } = await supabase
        .from('user_credits')
        .select('remaining_credits')
        .eq('user_id', user_id)
        .single();

    // 🆕 Get user email for logging
    const { data: userProfile } = await supabase
        .from('profiles')
        .select('email')
        .eq('id', user_id)
        .single();

    if (userCredits) {
        const balanceBefore = userCredits.remaining_credits;
        const newBalance = balanceBefore - amountToChargeNow;
        
        // Update credits
        await supabase.from('user_credits').update({ remaining_credits: newBalance }).eq('user_id', user_id);
        
        // 🆕 Sync to profiles table
        await supabase.from('profiles').update({ credits: newBalance }).eq('id', user_id);
        
        // Update processed sessions
        await supabase.from('processed_sessions').upsert({ 
            session_id: transcriptID,
            user_id: user_id, 
            charged_amount: finalCalculatedCost,
            last_sync: new Date().toISOString()
        }, { onConflict: 'session_id' });

        // 🆕 LOG THE TRANSACTION
        await logCreditTransaction({
            user_id,
            user_email: userProfile?.email || null,
            amount: amountToChargeNow,
            balance_before: balanceBefore,
            balance_after: newBalance,
            session_id: transcriptID,
            transaction_type: 'deduction',
            source: 'voiceflow',
            description: `שיחה: ${turnCount} הודעות, ${systemCount} מערכת, ${freeCount} חינם`,
            metadata: {
                transcript_id: transcriptID,
                vf_session_id: session_id,
                turn_count: turnCount,
                system_count: systemCount,
                free_count: freeCount,
                total_word_count: totalWordCount,
                already_paid: alreadyPaid,
                total_calculated: finalCalculatedCost
            }
        });

        return { 
            statusCode: 200, 
            headers, 
            body: JSON.stringify({ 
                success: true, 
                charged: amountToChargeNow,
                new_balance: newBalance,
                logged: true
            }) 
        };
    } 
    
    return { statusCode: 404, headers, body: JSON.stringify({ error: "User not found" }) };

  } catch (err) {
    console.error("🔥 Server Error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
