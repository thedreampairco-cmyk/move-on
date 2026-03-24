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

        console.log(`[Move-On Bot] Received: "${userText}"`);

        // 🚨 IMMEDIATELY return 200 so Green API closes the connection
        res.status(200).send('Message queued');

        // 🔥 RUN THE REST IN THE BACKGROUND
        (async () => {
            let userProfile = await User.findOne({ chatId: chatId });
            if (!userProfile) {
                userProfile = await User.create({
                    chatId: chatId, name: body.senderData.senderName || 'stranger', gender: 'male', memoryTags: {}
                });
            }

            const currentHour = new Date().getHours(); // Server time (IST)
            const systemPrompt = buildSystemPrompt({
                name: userProfile.name, timeContext: currentHour, memoryVault: userProfile.memoryTags || {}
            });

            const history = [ { role: 'user', content: userText } ]; 
            const botReply = await aiResponse.generateCompanionResponse(history, systemPrompt);

            if (botReply) {
                // ⏱️ THE ARTIFICIAL DELAY (Randomly between 30 seconds and 5 minutes)
                const minDelay = 30 * 100;
                const maxDelay = 10 * 1000; // 5 mins
                const delayMs = Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay);
                
                console.log(`[Behavioral Engine] Pausing for ${delayMs / 1000} seconds to simulate real typing...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));

                await greenApi.sendMessage(chatId, botReply);
                console.log(`✅ [Green API] Sent after delay: "${botReply}"`);
            }

            // Shadow Extraction
            aiResponse.extractMemoryTags(userText, userProfile.memoryTags).then(async (newTags) => {
                if (newTags) {
                    await User.updateOne({ chatId: chatId }, { $set: { memoryTags: { ...userProfile.memoryTags, ...newTags } } });
                }
            });
        })();

    } catch (error) {
        console.error('[Webhook Error]:', error.stack);
        if (!res.headersSent) res.status(200).send('Error Handled');
    }
});

module.exports = router;
