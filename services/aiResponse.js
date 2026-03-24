// services/aiResponse.js
const { Groq } = require('groq-sdk');
const env = require('../config/env');

const groq = new Groq({ apiKey: env.GROQ_API_KEY });

const aiResponse = {
    /**
     * Primary Call: Generates the fast conversational reply.
     */
    async generateCompanionResponse(history, systemPrompt) {
        try {
            const messages = [
                { role: 'system', content: systemPrompt },
                ...history
            ];

            const completion = await groq.chat.completions.create({
                messages,
                // 🔥 UPDATED: Active Primary Model
                model: "llama-3.3-70b-versatile", 
                temperature: 0.7, 
                max_tokens: 150, 
            });

            return completion.choices[0].message.content;
        } catch (error) {
            console.error('[Groq Error - Primary]:', error.message);
            return "my brain is entirely fried right now give me a sec..."; 
        }
    },

    /**
     * Shadow Extraction: Analyzes text for new facts to update the Memory Vault.
     */
    async extractMemoryTags(userMessage, currentMemory) {
        try {
            const extractionPrompt = `
You are a background data extractor. Analyze the user's message for new facts about their routine, preferences, ambitions, or ex-partner.
Current Memory: ${JSON.stringify(currentMemory)}
User Message: "${userMessage}"

If there are NO new facts, reply exactly with: null
If there ARE new facts, reply ONLY with a valid JSON object containing the new key-value pairs. Do not use markdown blocks.
Example: {"sleep_schedule": "late night", "wears": "casual shirts"}
`;

            const completion = await groq.chat.completions.create({
                messages: [{ role: 'user', content: extractionPrompt }],
                // 🔥 UPDATED: Active Shadow Extraction Model
                model: "llama-3.1-8b-instant", 
                temperature: 0.1,
            });

            const rawContent = completion.choices[0].message.content.trim();
            if (rawContent === 'null' || !rawContent) return null;

            const cleanJson = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(cleanJson);
        } catch (error) {
            console.error('[Groq Error - Shadow Extraction]:', error.message);
            return null; 
        }
    }
};

module.exports = aiResponse;
