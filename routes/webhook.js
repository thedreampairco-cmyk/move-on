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

        console.log("🚨 RAW WEBHOOK HIT:\n", JSON.stringify(body, null, 2));

        // 1. Filter
        const validTypes = ['textMessage', 'extendedTextMessage'];
        if (body.typeWebhook !== 'incomingMessageReceived' || 
            !body.messageData || 
            !validTypes.includes(body.messageData.typeMessage)) {
            return res.status(200).send('Ignored');
        }

        const chatId = body.senderData.chatId;
        
        // Extract text
        let userText = "";
        if (body.messageData.typeMessage === 'textMessage') {
            userText = body.messageData.textMessageData.textMessage;
        } else if (body.messageData.typeMessage === 'extendedTextMessage') {
            userText = body.messageData.extendedTextMessageData.text;
        }

        console.log(`[Move-On Bot] Processing message from ${chatId}: "${userText}"`);

        // 2. Fetch User & Memory Vault 
        // 🔥 FIX: Querying by chatId instead of phone
        let userProfile = await User.findOne({ chatId: chatId });
        
        if (!userProfile) {
            // 🔥 FIX: Saving as chatId instead of phone
            userProfile = await User.create({
                chatId: chatId,
                name: body.senderData.senderName || 'there',
                gender: 'unknown',
                memoryTags: {}
            });
            console.log(`[Database] Created new profile for ${chatId}`);
        }

        // 3. Time-Aware Context Injection
        const currentHour = new Date().getHours();
        let timeContext = `It is currently ${currentHour}:00. `;
        if (currentHour >= 8 && currentHour < 18) {
            timeContext += "Daytime Mode: Act busy, casual, focused on routine (coffee, work, minor inconveniences).";
        } else if (currentHour >= 20 || currentHour < 2) {
            timeContext += "Nighttime Mode: Shift tone. Be intimate, deep, slightly vulnerable. Ask philosophical questions.";
        } else {
            timeContext += "Evening transition mode: Winding down the day.";
        }

        // 4. Build System Prompt & History
        const systemPrompt = buildSystemPrompt({
            name: userProfile.name,
            gender: userProfile.gender,
            timeContext: timeContext,
            memoryVault: userProfile.memoryTags || {}
        });

        const history = [ { role: 'user', content: userText } ]; 

        // 5. Await Primary AI Response
        console.log(`[Groq] Generating primary response...`);
        const botReply = await aiResponse.generateCompanionResponse(history, systemPrompt);

        // 6. Deliver the message via Green API
        if (botReply) {
            console.log(`[Green API] Attempting to send reply: "${botReply}"`);
            await greenApi.sendMessage(chatId, botReply);
            console.log(`✅ [Green API] Reply successfully sent to ${chatId}`);
        }

        // 7. FIRE AND FORGET: Shadow Extraction
        aiResponse.extractMemoryTags(userText, userProfile.memoryTags)
            .then(async (newTags) => {
                if (newTags && Object.keys(newTags).length > 0) {
                    const updatedTags = { ...userProfile.memoryTags, ...newTags };
                    // 🔥 FIX: Updating by chatId instead of phone
                    await User.updateOne(
                        { chatId: chatId }, 
                        { $set: { memoryTags: updatedTags } }
                    );
                    console.log(`[Memory Vault Updated] for ${chatId}:`, newTags);
                }
            })
            .catch(err => console.error('[Shadow Extraction Promise Error]:', err.message));

        return res.status(200).send('Message Processed');

    } catch (error) {
        console.error('[Webhook Critical Error]:', error.stack);
        return res.status(200).send('Error Handled Gracefully');
    }
});

module.exports = router;
