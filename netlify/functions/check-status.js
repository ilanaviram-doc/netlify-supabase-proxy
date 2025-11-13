// קובץ: netlify/functions/check-status.js

// ה-URL של הפונקציה ב-Supabase שאנו מנסים להגיע אליה
// ודא שאתה משתמש בכתובת החדשה: check-status-v2
const SUPABASE_FUNCTION_URL = "https://rmgtegimphpjzxcflotn.supabase.co/functions/v1/check-status-v2";

exports.handler = async (event, context) => {
    // 1. טיפול ב-OPTIONS (חובה ל-CORS)
    if (event.httpMethod === "OPTIONS") {
        return {
            statusCode: 200,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Authorization, Content-Type",
            },
            body: "OK",
        };
    }

    try {
        // 2. העברת הבקשה מ-Voiceflow ל-Supabase
        
        const headersToForward = {
            "Content-Type": "application/json",
            "Authorization": event.headers.authorization, // מעביר את ה-Bearer Token הלאה
        };
        
        const bodyToForward = event.body;

        // ביצוע בקשת POST ל-Supabase Edge Function
        const response = await fetch(SUPABASE_FUNCTION_URL, {
            method: "POST",
            headers: headersToForward,
            body: bodyToForward,
        });

        // 3. החזרת התגובה ל-Voiceflow
        const data = await response.json();

        return {
            statusCode: response.status,
            headers: {
                "Access-Control-Allow-Origin": "*", // מאפשר ל-Voiceflow לקרוא את התשובה
                "Content-Type": "application/json",
            },
            body: JSON.stringify(data),
        };
        
    } catch (error) {
        console.error("Proxy error:", error);
        return {
            statusCode: 500,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ status: "BLOCKED", error: "Proxy failed" }),
        };
    }
};