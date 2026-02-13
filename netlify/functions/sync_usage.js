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
    //    🆕 FIX: Greeting/intro bot messages before first user input = FREE
    // ============================================================
    let totalScore = 0;
    let turnCount = 0;
    let freeCount = 0;
    let systemCount = 0;
    let totalWordCount = 0;
    let firstUserMessageSeen = false; // 🆕 Track greeting phase

    logs.forEach(log => {
        const content = extractTextFromLog(log);
        
        if (content && content.length > 1) { 
            
            // 🆓 FREE: All bot messages BEFORE the first real user message = greeting/intro = FREE
            if (!firstUserMessageSeen) {
                if (log.type === 'action') {
                    // First user message found - greeting phase is over
                    firstUserMessageSeen = true;
                    // Continue to process this user message normally below
                } else if (log.type === 'trace') {
                    // Bot message before any user interaction = greeting = FREE!
                    console.log(`🆓 FREE: Greeting/intro bot message (before first user input)`);
                    freeCount++;
                    return;
                }
            }
            
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
            totalWordCount += wordCount;
            
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

    // Get user email for logging
    const { data: userProfile } = await supabase
        .from('profiles')
        .select('email')
        .eq('id', user_id)
        .single();

    if (userCredits) {
        const balanceBefore = userCredits.remaining_credits;
        const newBalance = balanceBefore - amountToChargeNow;
        
        // ✅ FIX: Atomic-style operations with error checking
        // Step 1: Deduct from user_credits (the critical operation)
        const { error: creditError } = await supabase
            .from('user_credits')
            .update({ remaining_credits: newBalance })
            .eq('user_id', user_id);
        
        if (creditError) {
            // ❌ CRITICAL: If credit deduction failed, DO NOT update processed_sessions!
            // This prevents the bug where processed_sessions advances but credits aren't deducted
            console.error('❌ CRITICAL: user_credits update FAILED:', creditError.message);
            console.error('❌ NOT updating processed_sessions to prevent desync');
            return { 
                statusCode: 500, 
                headers, 
                body: JSON.stringify({ 
                    error: "Credit deduction failed", 
                    detail: creditError.message 
                }) 
            };
        }
        
        console.log(`✅ user_credits updated: ${balanceBefore} → ${newBalance}`);
        
        // Step 2: Sync to profiles table (non-critical, log error but continue)
        const { error: profileError } = await supabase
            .from('profiles')
            .update({ credits: newBalance })
            .eq('id', user_id);
        
        if (profileError) {
            console.warn('⚠️ profiles sync failed (non-critical):', profileError.message);
        }
        
        // Step 3: Update processed_sessions (only after credits successfully deducted)
        const { error: sessionError } = await supabase
            .from('processed_sessions')
            .upsert({ 
                session_id: transcriptID,
                user_id: user_id, 
                charged_amount: finalCalculatedCost,
                last_sync: new Date().toISOString()
            }, { onConflict: 'session_id' });
        
        if (sessionError) {
            // ⚠️ Credits were deducted but tracking failed
            // This is less bad — user was charged correctly, just tracking is off
            // Next sync will see old charged_amount and may double-charge
            // Log prominently so we can investigate
            console.error('⚠️ WARNING: processed_sessions update FAILED after credits deducted!');
            console.error('⚠️ User:', user_id, 'Amount:', amountToChargeNow, 'Error:', sessionError.message);
            console.error('⚠️ This may cause double-charging on next sync!');
        }

        // Step 4: Log the transaction (non-critical, for audit trail)
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
    
    console.error(`❌ User not found in user_credits: ${user_id}`);
    return { statusCode: 404, headers, body: JSON.stringify({ error: "User not found" }) };

  } catch (err) {
    console.error("🔥 Server Error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
