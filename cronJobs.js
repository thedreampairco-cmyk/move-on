// cronJobs.js
const cron = require('node-cron');
const User = require('./models/User');
const { sendMessage } = require('./services/greenApi');
const { generateAiResponse } = require('./services/aiResponse');

console.log("[Cron] Background proactive messaging initialized.");

// Run every hour at minute 0
cron.schedule('0 * * * *', async () => {
    console.log("[Cron] Checking for inactive users...");

    // Calculate the timestamp for 12 hours ago
    const twelveHoursAgo = Date.now() - (12 * 60 * 60 * 1000);

    try {
        // Find users who haven't been active in 12+ hours
        const inactiveUsers = await User.find({
            lastActiveTimestamp: { $lt: twelveHoursAgo }
        });

        for (const user of inactiveUsers) {
            // Instruct Groq to generate a specific "double text" based on her persona
            const doubleTextPrompt = "The user hasn't replied in 12 hours. Generate a short, casual 'double text' checking in on them as a Delhi UPSC student taking a study break. Keep it to one sentence.";
            
            // Generate the proactive text
            const aiResponse = await generateAiResponse(user, doubleTextPrompt, true);
            
            // Send via WhatsApp
            await sendMessage(user.chatId, aiResponse.text);

            // Update database to prevent spamming them every hour
            user.lastActiveTimestamp = Date.now(); 
            user.chatHistory.push({ role: 'assistant', content: aiResponse.text, timestamp: Date.now() });
            await user.save();

            console.log(`[Cron] Sent proactive double-text to ${user.chatId}`);
        }
    } catch (error) {
        console.error("[Cron Error] Failed to process proactive messages:", error);
    }
});
