// services/memoryStore.js
const User = require('../models/User'); // Assuming Mongoose schema
const { GROQ_API_KEY } = require('../config/env');

/**
 * Fetches the user profile and chat history from MongoDB.
 */
async function getUserProfile(chatId) {
    let user = await User.findOne({ chatId });
    if (!user) {
        user = await User.create({ 
            chatId, 
            coreMemories: [], 
            chatHistory: [],
            lastActiveTimestamp: Date.now()
        });
    }
    return user;
}

/**
 * Saves a new message to the sliding window history.
 */
async function saveMessage(chatId, role, content) {
    await User.updateOne(
        { chatId },
        { 
            $push: { chatHistory: { role, content, timestamp: Date.now() } },
            $set: { lastActiveTimestamp: Date.now() }
        }
    );
}

/**
 * Uses Groq to extract new relationship facts from the recent chat history
 * and appends them to the user's coreMemories array.
 */
async function updateCoreMemories(chatId, recentUserMessage) {
    try {
        const user = await User.findOne({ chatId });
        
        // Prompt Groq to act as an entity extractor
        const extractionPrompt = `
        Analyze this new message from the user: "${recentUserMessage}"
        Extract any new, permanent facts about the user (e.g., their name, job, pet's name, ex's name, emotional state).
        Return ONLY a JSON array of strings. If no new facts, return [].
        Example: ["User has a dog named Max", "User works as a backend dev"]
        `;

        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${GROQ_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "mixtral-8x7b-32768", // Or your preferred Groq model
                messages: [{ role: "user", content: extractionPrompt }],
                temperature: 0.1
            })
        });

        const data = await response.json();
        const extractedText = data.choices[0].message.content;
        
        // Parse the JSON array
        const newFacts = JSON.parse(extractedText);
        
        if (newFacts && newFacts.length > 0) {
            await User.updateOne(
                { chatId },
                { $addToSet: { coreMemories: { $each: newFacts } } } // $addToSet prevents duplicates
            );
            console.log(`[Memory] Updated core memories for ${chatId}:`, newFacts);
        }
    } catch (error) {
        console.error("[Memory Error] Fact extraction failed:", error.message);
    }
}

module.exports = {
    getUserProfile,
    saveMessage,
    updateCoreMemories
};
