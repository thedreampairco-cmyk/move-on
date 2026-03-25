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

        // 🚨 IMMEDIATELY return 200 to acknowledge receipt and close the Green API connection
        res.status(200).send('Message queued');

        // 🔥 RUN THE CONTEXTUAL LOGIC IN THE BACKGROUND
        (async () => {
            try {
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
                let history = userProfile.chatHistory || [];
                history.push({ role: 'user', content: userText });

                // Keep history lean (last 15 messages) to avoid token bloat
                const contextWindow = history.slice(-15);

                // 🧹 3. CLEAN THE DATA FOR GROQ API (The Fix)
                // Strip out Mongoose '_id' and 'timestamp' fields
                const cleanContext = contextWindow.map(msg => ({
                    role: msg.role,
                    content: msg.content
                }));

                const currentHour = new Date().getHours(); 
                const systemPrompt = buildSystemPrompt({
                    name: userProfile.name, 
                    timeContext: currentHour, 
                    memoryVault: userProfile.memoryTags || {}
                });

                // 4. Generate Response using the CLEAN Context Window
                const botReply = await aiResponse.generateCompanionResponse(cleanContext, systemPrompt);

                if (botReply) {
                    // 5. Update History with AI's reply and Save to DB
                    history.push({ role: 'assistant', content: botReply });
                    
                    await User.updateOne(
                        { chatId: chatId }, 
                        { $set: { chatHistory: history.slice(-20) } } // Keep a rolling buffer in DB
                    );

                    // ⏱️ THE ARTIFICIAL DELAY
                    const minDelay = 3 * 1000; // 15 seconds
                    const maxDelay = 30 * 1000; // 3 minutes
                    const delayMs = Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay);

                    console.log(`[Behavioral Engine] Waiting ${Math.round(delayMs / 1000)}s before replying...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));

                    await greenApi.sendMessage(chatId, botReply);
                    console.log(`✅ [Green API] Sent: "${botReply}"`);
                }

                // 6. Shadow Extraction (Background memory tagging task)
                aiResponse.extractMemoryTags(userText, userProfile.memoryTags).then(async (newTags) => {
                    if (newTags) {
                        await User.updateOne(
                            { chatId: chatId }, 
                            { $set: { memoryTags: { ...userProfile.memoryTags, ...newTags } } }
                        );
                    }
                });

            } catch (backgroundError) {
                console.error('[Background Task Error]:', backgroundError);
            }
        })();

    } catch (error) {
        console.error('[Webhook Error]:', error.stack);
        if (!res.headersSent) res.status(200).send('Error Handled');
    }
});

module.exports = router;
