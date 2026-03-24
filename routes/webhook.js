// routes/webhook.js
const express = require('express');
const router = express.Router();
const { sendMessage, sendMediaByUrl } = require('../services/greenApi');
const { getUserProfile, saveMessage, updateCoreMemories } = require('../services/memoryStore');
const { generateAiResponse } = require('../services/aiResponse'); // Wrapper for your Groq chat completion

router.post('/greenapi-webhook', async (req, res) => {
    // 1. Acknowledge Green API immediately to prevent retries
    res.sendStatus(200);

    const body = req.body;
    
    // 2. Only process incoming text messages
    if (body.typeWebhook !== 'incomingMessageReceived' || !body.messageData.textMessageData) {
        return; 
    }

    const chatId = body.senderData.chatId;
    const userText = body.messageData.textMessageData.textMessage;

    try {
        // 3. Load state and update timestamps
        const user = await getUserProfile(chatId);
        await saveMessage(chatId, 'user', userText);

        // 4. Background Fact Extraction (Non-blocking)
        updateCoreMemories(chatId, userText); 

        // 5. Generate Her Response (Passes history & memories to Groq)
        // Note: generateAiResponse handles calling buildSystemPrompt.js internally
        const aiPayload = await generateAiResponse(user, userText);

        // 6. Media Routing: Did Groq decide to send a "selfie"?
        if (aiPayload.imageUrl) {
            // Send the photo with her text as the caption
            await sendMediaByUrl(chatId, aiPayload.imageUrl, "selfie.jpeg", aiPayload.text);
        } else {
            // Just a standard text response
            await sendMessage(chatId, aiPayload.text);
        }

        // 7. Save her response to history
        await saveMessage(chatId, 'assistant', aiPayload.text);

    } catch (error) {
        console.error("[Webhook Error]:", error);
    }
});

module.exports = router;
