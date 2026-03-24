// services/greenApi.js
const axios = require('axios');
const env = require('../config/env');

const greenApi = {
    async sendMessage(chatId, message) {
        try {
            // 🚨 BRUTE FORCE: Grabbing the ID and Token directly from Render's core memory
            const id = String(process.env.GREEN_API_ID_INSTANCE || process.env.GREEN_API_ID || process.env.GREEN || env.GREEN_API_ID || '').trim();
            const token = String(process.env.GREEN_API_API_TOKEN_INSTANCE || process.env.GREEN_API_TOKEN || env.GREEN_API_TOKEN || '').trim();

            if (!id || !token) {
                console.error("❌ CRITICAL: Green API ID or Token is completely missing from Render!");
                return null;
            }

            // 🔥 FIX: Based on your logs, your instance is 7103529867. 
            // The Green API server MUST be the 7103 subdomain.
            const baseUrl = 'https://7103.api.greenapi.com'; 
            
            const url = `${baseUrl}/waInstance${id}/sendMessage/${token}`;
            
            // Safe logging to prove the ID is actually in the URL this time
            console.log(`[Green API Check] Routing to: ${baseUrl}/waInstance${id}/sendMessage/********`);

            const payload = { chatId, message };
            const response = await axios.post(url, payload);
            return response.data;
            
        } catch (error) {
            console.error('[GreenAPI Error] Failed to send message:', error.response?.data || error.message);
            return null; 
        }
    }
};

module.exports = greenApi;
