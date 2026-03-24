// routes/webhook.js
const express = require('express');
const router = express.Router();
const greenApi = require('../services/greenApi');
const aiResponse = require('../services/aiResponse');
const { buildSystemPrompt } = require('../services/buildSystemPrompt');
const User = require('../models/User'); // Assuming Mongoose model exists

router.post('/', async (req, res) => {
    try {
        const body = req.body;

        // 1. Filter: Process only incoming text messages
        if (body.typeWebhook !== 'incomingMessageReceived' || 
            !body.messageData || 
            body.messageData.typeMessage !== 'textMessage') {
            return res.status(200).send('Ignored: Not a text message');
        }

        const chatId = body.senderData.chatId;
        const userText = body.messageData.textMessageData.textMessage;

        console.log(`[Move-On Bot] Message from ${chatId}: "${userText}"`);

        // 2. Fetch User & Memory Vault
        let userProfile = await User.findOne({ phone: chatId });
        
        // Safety Fallback (If bypassing Onboarding for testing)
        if (!userProfile) {
            userProfile = await User.create({
                phone: chatId,
                name: body.senderData.senderName || 'there',
                gender: 'unknown', // Ideally set during an onboarding flow
                memoryTags: {}
            });
        }

        // 3. Time-Aware Context Injection (Local IST time assumption)
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

        // (In a full app, you would pull the last 5 messages from a memoryStore here)
        const history = [ { role: 'user', content: userText } ]; 

        // 5. Await Primary AI Response
        const botReply = await aiResponse.generateCompanionResponse(history, systemPrompt);

        // 6. Deliver the message via Green API
        if (botReply) {
            await greenApi.sendMessage(chatId, botReply);
        }

        // 7. FIRE AND FORGET: Shadow Extraction
        // Notice there is NO 'await' here. It runs asynchronously in the background.
        aiResponse.extractMemoryTags(userText, userProfile.memoryTags)
            .then(async (newTags) => {
                if (newTags && Object.keys(newTags).length > 0) {
                    // Merge new tags with existing tags
                    const updatedTags = { ...userProfile.memoryTags, ...newTags };
                    await User.updateOne(
                        { phone: chatId }, 
                        { $set: { memoryTags: updatedTags } }
                    );
                    console.log(`[Memory Vault Updated] for ${chatId}:`, newTags);
                }
            })
            .catch(err => console.error('[Shadow Extraction Promise Error]:', err.message));

        // 8. Close Webhook connection immediately to prevent CPU freezing on cloud hosts
        return res.status(200).send('Message Processed');

    } catch (error) {
        console.error('[Webhook Critical Error]:', error.stack);
        // Always return 200 to stop Green API from aggressively retrying
        return res.status(200).send('Error Handled Gracefully');
    }
});

module.exports = router;
