const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const VF_PROJECTS = {
    psychodynamic_adults: {
        projectID: '69959a1f96fd12fff6692b6d',
        apiKey: 'VF.DM.699600edf79fb10a552322f8.OyQC5L0acLwNHjfn'
    },
    psychodynamic_children: {
        projectID: '69958e2496fd12fff66928c7',
        apiKey: 'VF.DM.6996013bddce1f3281f671f5.fY8gv93hcf0wUSVv'
    },
    psychodynamic_parents: {
        projectID: '68d9462f0d7ce042ebb9af90',
        apiKey: 'VF.DM.68d9706c1305d072a1df8ce6.53ui9DPMyvkQ9QRO'
    },
    cbt: {
        projectID: '69958a4396fd12fff66927ea',
        apiKey: 'VF.DM.6996029741096f2458cc783f.i6JnW5cIt1FXEcpn'
    },
    trauma: {
        projectID: '69a3f7f5c0c1216a818db914',
        apiKey: 'VF.DM.69ad21fb6ef184469efcd20a.Dws9LKtLUulD9OIS'
    }
};

const DEFAULT_AGENT = 'psychodynamic_adults';

const SYSTEM_MESSAGE_PATTERNS = [
    'שלום', 'ברוכים הבאים', 'ברוך הבא', 'ברוכה הבאה',
    'היי', 'hello', 'welcome', 'hi there',
    'חזרת', 'שמחים לראותך', 'ברוכים השבים', 'טוב שחזרת',
    'לא היית פעיל', 'עבר זמן', 'הרבה זמן',
    'איך אפשר לעזור', 'במה אוכל לעזור', 'מה תרצה',
    'בחר אפשרות', 'בחרי אפשרות', 'לחץ על', 'לחצי על',
    'להתראות', 'ביי', 'תודה שפנית', 'נשמח לעזור שוב'
];

const BUTTON_RESPONSE_PATTERNS = [
    'כן', 'לא', 'אישור', 'ביטול', 'סגור', 'המשך',
    'הבא', 'חזור', 'התחל', 'סיים', 'שלח', 'אשר',
    'ok', 'yes', 'no', 'cancel', 'start', 'continue',
    'back', 'next', 'done', 'submit'
];

function isSystemMessage(content, logType) {
    if (!content || content.length === 0) return { skip: true, cost: 0 };
    
    const contentLower = content.toLowerCase().trim();
    
    if (logType === 'action' && contentLower.length < 5) {
        console.log(`🆓 FREE: Very short user message (${contentLower.length} chars)`);
        return { skip: true, cost: 0 };
    }
    
    if (logType === 'action' && contentLower.length <= 15) {
        for (const pattern of BUTTON_RESPONSE_PATTERNS) {
            if (contentLower === pattern.toLowerCase() || contentLower.includes(pattern.toLowerCase())) {
                console.log(`🆓 FREE: Button click ("${content}")`);
                return { skip: true, cost: 0 };
            }
        }
    }

    // ✅ כל action = לחיצת כפתור = חינם
    if (logType === 'action') {
        console.log(`🆓 FREE: Button label click ("${content}")`);
        return { skip: true, cost: 0 };
    }
    
    if (logType === 'trace' && contentLower.length < 50) {
        console.log(`💰 SYSTEM: Short bot message (${contentLower.length} chars) = 1 credit`);
        return { skip: false, cost: 1 };
    }
    
    if (logType === 'trace') {
        for (const pattern of SYSTEM_MESSAGE_PATTERNS) {
            if (contentLower.includes(pattern.toLowerCase())) {
                console.log(`💰 SYSTEM: "${pattern}" = 1 credit`);
                return { skip: false, cost: 1 };
            }
        }
    }
    
    return { skip: false, cost: null };
}

function extractTextFromLog(log) {
    try {
        if (log.type === 'trace' && log.data && log.data.payload) {
            if (log.data.payload.message) return log.data.payload.message;
            if (log.data.payload.slate) return JSON.stringify(log.data.payload.slate);
        }

        if (log.type === 'action' && log.data && log.data.payload) {
            // ✅ תיקון: תמיכה גם ב-payload.payload וגם ב-payload.label
            if (log.data.payload.payload && typeof log.data.payload.payload === 'string') {
                return log.data.payload.payload;
            }
            if (log.data.payload.label && typeof log.data.payload.label === 'string') {
                return log.data.payload.label;
            }
            if (typeof log.data.payload === 'string') return log.data.payload;
        }
    } catch (e) { return ""; }
    
    return "";
}

async function logCreditTransaction(params) {
    const {
        user_id, user_email, amount, balance_before, balance_after,
        session_id, agent_type = null, transaction_type = 'deduction',
        source = 'voiceflow', description = null, metadata = null
    } = params;

    try {
        const { error } = await supabase
            .from('credit_logs')
            .insert({
                user_id, user_email,
                amount: -Math.abs(amount),
                transaction_type, balance_before, balance_after, source,
                voiceflow_session_id: session_id, agent_type, description, metadata
            });

        if (error) {
            console.error('❌ Failed to log credit transaction:', error.message);
        } else {
            console.log(`📝 Logged: ${amount} credits deducted from ${user_email} [${agent_type || 'unknown'}]`);
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
    const { session_id, user_id, agent_type } = JSON.parse(event.body);

    if (!session_id || !user_id) return { 
        statusCode: 400, headers, 
        body: JSON.stringify({ error: "Missing params" }) 
    };

    const resolvedAgent = agent_type && VF_PROJECTS[agent_type] ? agent_type : DEFAULT_AGENT;
    const VF_PROJECT_ID = VF_PROJECTS[resolvedAgent].projectID;
    const VF_API_KEY = VF_PROJECTS[resolvedAgent].apiKey;

    console.log(`🔍 [SERVER] Syncing for UserID: ${session_id} | Agent: ${resolvedAgent} | Project: ${VF_PROJECT_ID}`);

    const searchUrl = `https://analytics-api.voiceflow.com/v1/transcript/project/${VF_PROJECT_ID}`;
    const searchResponse = await fetch(searchUrl, { 
        method: 'POST', 
        headers: { 'authorization': VF_API_KEY, 'Content-Type': 'application/json' },
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

    transcriptsList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const transcriptID = transcriptsList[0]._id || transcriptsList[0].id;
    console.log(`✅ Found Transcript ID: ${transcriptID}`);

    const detailUrl = `https://analytics-api.voiceflow.com/v1/transcript/${transcriptID}?filterConversation=false`;
    const detailResponse = await fetch(detailUrl, { headers: { 'authorization': VF_API_KEY } });

    if (!detailResponse.ok) return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };

    const data = await detailResponse.json();
    const logs = data.transcript?.logs || []; 

    console.log(`🐛 Raw Logs Found: ${logs.length}`);

    let totalScore = 0;
    let turnCount = 0;
    let freeCount = 0;
    let systemCount = 0;
    let totalWordCount = 0;
    let firstUserMessageSeen = false;

    logs.forEach(log => {
        const content = extractTextFromLog(log);
        
        if (content && content.length > 1) { 
            
            if (!firstUserMessageSeen) {
                if (log.type === 'action') {
                    firstUserMessageSeen = true;
                } else if (log.type === 'trace') {
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
    console.log(`📊 Analysis: ${turnCount} paid + ${systemCount} system (1 each) + ${freeCount} free. Total: ${finalCalculatedCost} | Agent: ${resolvedAgent}`);

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

    console.log(`💳 CHARGING: ${amountToChargeNow} credits [${resolvedAgent}]`);

    const { data: userCredits } = await supabase
        .from('user_credits')
        .select('remaining_credits')
        .eq('user_id', user_id)
        .single();

    const { data: userProfile } = await supabase
        .from('profiles')
        .select('email')
        .eq('id', user_id)
        .single();

    if (userCredits) {
        const balanceBefore = userCredits.remaining_credits;
        const newBalance = balanceBefore - amountToChargeNow;
        
        const { error: creditError } = await supabase
            .from('user_credits')
            .update({ remaining_credits: newBalance })
            .eq('user_id', user_id);
        
        if (creditError) {
            console.error('❌ CRITICAL: user_credits update FAILED:', creditError.message);
            return { 
                statusCode: 500, headers, 
                body: JSON.stringify({ error: "Credit deduction failed", detail: creditError.message }) 
            };
        }
        
        console.log(`✅ user_credits updated: ${balanceBefore} → ${newBalance}`);
        
        const { error: profileError } = await supabase
            .from('profiles')
            .update({ credits: newBalance })
            .eq('id', user_id);
        
        if (profileError) {
            console.warn('⚠️ profiles sync failed (non-critical):', profileError.message);
        }
        
        const { error: sessionError } = await supabase
            .from('processed_sessions')
            .upsert({ 
                session_id: transcriptID,
                user_id: user_id, 
                charged_amount: finalCalculatedCost,
                last_sync: new Date().toISOString()
            }, { onConflict: 'session_id' });
        
        if (sessionError) {
            console.error('⚠️ WARNING: processed_sessions update FAILED:', sessionError.message);
        }

        await logCreditTransaction({
            user_id,
            user_email: userProfile?.email || null,
            amount: amountToChargeNow,
            balance_before: balanceBefore,
            balance_after: newBalance,
            session_id: transcriptID,
            agent_type: resolvedAgent,
            transaction_type: 'deduction',
            source: 'voiceflow',
            description: `שיחה: ${turnCount} הודעות, ${systemCount} מערכת, ${freeCount} חינם [${resolvedAgent}]`,
            metadata: {
                transcript_id: transcriptID,
                vf_session_id: session_id,
                agent_type: resolvedAgent,
                turn_count: turnCount,
                system_count: systemCount,
                free_count: freeCount,
                total_word_count: totalWordCount,
                already_paid: alreadyPaid,
                total_calculated: finalCalculatedCost
            }
        });

        return { 
            statusCode: 200, headers, 
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
