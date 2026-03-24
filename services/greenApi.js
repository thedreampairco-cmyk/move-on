// services/greenApi.js
const axios = require('axios');
const env = require('../config/env');

const greenApi = {
    async sendMessage(chatId, message) {
        try {
            // .trim() acts as a sanitizer to destroy invisible spaces from Render
            const id = String(env.GREEN_API_ID || '').trim();
            const token = String(env.GREEN_API_TOKEN || '').trim();

            // 🛑 PASTE YOUR EXACT URL ON THE NEXT LINE:
            // Example: 'https://7103.api.greenapi.com'
            const baseUrl = 'https://api.green-api.com'; 
            
            const url = `${baseUrl}/waInstance${id}/sendMessage/${token}`;
            
            // This will log the URL safely so we can prove it's correct
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

