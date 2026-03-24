// services/greenApi.js
const axios = require('axios');
const env = require('../config/env'); // Assumes you have env configs set up

const GREEN_API_URL = `https://api.green-api.com/waInstance${env.GREEN_API_ID}`;

const greenApi = {
    /**
     * Sends a text message to the user.
     * @param {string} chatId - WhatsApp ID (e.g., "1234567890@c.us")
     * @param {string} message - The text to send
     */
    async sendMessage(chatId, message) {
        try {
            const url = `${GREEN_API_URL}/sendMessage/${env.GREEN_API_TOKEN}`;
            const payload = { chatId, message };
            
            const response = await axios.post(url, payload);
            return response.data;
        } catch (error) {
            // Log the error but do not throw, preventing server crashes on 500/429s from Green API
            console.error('[GreenAPI Error] Failed to send message:', error.response?.data || error.message);
            return null; 
        }
    }
};

module.exports = greenApi;
