// routes/webhook.js
const express = require('express');
const router = express.Router();
const greenApi = require('../services/greenApi');
const aiResponse = require('../services/aiResponse');
const { buildSystemPrompt } = require('../services/buildSystemPrompt');
const User = require('../models/User');

router.post('/', async (req, res) => {
    try {
        const body = req.body;
        const validTypes = ['textMessage', 'extendedTextMessage'];

        if (body.typeWebhook !== 'incomingMessageReceived' ||
            !body.messageData ||
            !validTypes.includes(body.messageData.typeMessage)) {
            return res.status(200).send('Ignored');
        }

        const chatId = body.senderData.chatId;
        let userText = body.messageData.typeMessage === 'textMessage'
            ? body.messageData.textMessageData.textMessage
            : body.messageData.extendedTextMessageData.text;

        console.log(`[Move-On Bot] Received from ${chatId}: "${userText}"`);

        // 🚨 IMMEDIATELY return 200 to acknowledge receipt
        res.status(200).send('Message queued');

        // 🔥 RUN THE CONTEXTUAL LOGIC IN THE BACKGROUND
        (async () => {
            // 1. Fetch User (Ensure your User model has a 'chatHistory' array field)
            let userProfile = await User.findOne({ chatId: chatId });
            if (!userProfile) {
                userProfile = await User.create({
                    chatId: chatId, 
                    name: body.senderData.senderName || 'stranger', 
                    gender: 'male', 
                    memoryTags: {},
                    chatHistory: [] // Initialize history
                });
            }

            // 2. Prepare Conversation History
            // We take the existing history and add the current user message
            let history = userProfile.chatHistory || [];
            history.push({ role: 'user', content: userText });

            // Keep history lean (last 15 messages) to avoid token bloat and confusion
            const contextWindow = history.slice(-15);

            const currentHour = new Date().getHours(); 
            const systemPrompt = buildSystemPrompt({
                name: userProfile.name, 
                timeContext: currentHour, 
                memoryVault: userProfile.memoryTags || {}
            });

            // 3. Generate Response using the FULL Context Window
            const botReply = await aiResponse.generateCompanionResponse(contextWindow, systemPrompt);

            if (botReply) {
                // 4. Update History with AI's reply and Save to DB
                history.push({ role: 'assistant', content: botReply });
                await User.updateOne(
                    { chatId: chatId }, 
                    { $set: { chatHistory: history.slice(-20) } } // Store slightly more than we send
                );

                // ⏱️ THE ARTIFICIAL DELAY (Corrected to match your 5-min intent)
                const minDelay = 15 * 1000; // 15 seconds
                const maxDelay = 3 * 60 * 1000; // 3 minutes (5 mins might make users think it crashed)
                const delayMs = Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay);

                console.log(`[Behavioral Engine] Waiting ${Math.round(delayMs / 1000)}s before replying...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));

                await greenApi.sendMessage(chatId, botReply);
                console.log(`✅ [Green API] Sent: "${botReply}"`);
            }

            // 5. Shadow Extraction (Background task)
            aiResponse.extractMemoryTags(userText, userProfile.memoryTags).then(async (newTags) => {
                if (newTags) {
                    await User.updateOne(
                        { chatId: chatId }, 
                        { $set: { memoryTags: { ...userProfile.memoryTags, ...newTags } } }
                    );
                }
            });
        })();

    } catch (error) {
        console.error('[Webhook Error]:', error.stack);
        if (!res.headersSent) res.status(200).send('Error Handled');
    }
});

module.exports = router;
