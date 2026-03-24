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

        // 🚨 THE LIE DETECTOR: This will print the exact JSON Green API sends
        console.log("🚨 RAW WEBHOOK HIT:\n", JSON.stringify(body, null, 2));

        // 1. Filter: Process only incoming text messages
        if (body.typeWebhook !== 'incomingMessageReceived' || 
            !body.messageData || 
            body.messageData.typeMessage !== 'textMessage') {
            console.log("⚠️ Ignored: Event is not an incoming text message.");
            return res.status(200).send('Ignored: Not a text message');
        }

        const chatId = body.senderData.chatId;
        const userText = body.messageData.textMessageData.textMessage;

        console.log(`[Move-On Bot] Processing message from ${chatId}: "${userText}"`);

        // 2. Fetch User & Memory Vault
        let userProfile = await User.findOne({ phone: chatId });
        
        // Safety Fallback (Creates profile if they haven't texted before)
        if (!userProfile) {
            userProfile = await User.create({
                phone: chatId,
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
            await greenApi.sendMessage(chatId, botReply);
            console.log(`[Green API] Sent reply to ${chatId}`);
        }

        // 7. FIRE AND FORGET: Shadow Extraction
        // This runs asynchronously in the background.
        aiResponse.extractMemoryTags(userText, userProfile.memoryTags)
            .then(async (newTags) => {
                if (newTags && Object.keys(newTags).length > 0) {
                    const updatedTags = { ...userProfile.memoryTags, ...newTags };
                    await User.updateOne(
                        { phone: chatId }, 
                        { $set: { memoryTags: updatedTags } }
                    );
                    console.log(`[Memory Vault Updated] for ${chatId}:`, newTags);
                }
            })
            .catch(err => console.error('[Shadow Extraction Promise Error]:', err.message));

        // 8. Close Webhook connection immediately to prevent timeouts
        return res.status(200).send('Message Processed');

    } catch (error) {
        console.error('[Webhook Critical Error]:', error.stack);
        // Always return 200 to stop Green API from aggressively retrying and spamming your server
        return res.status(200).send('Error Handled Gracefully');
    }
});

module.exports = router;
