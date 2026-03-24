// config/env.js
const path = require('path');
// Force dotenv to look exactly one folder above 'config'
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

module.exports = {
    PORT: process.env.PORT || 3000,
    MONGO_URI: process.env.MONGO_URI,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GREEN_API_ID: process.env.GREEN_API_ID,
    GREEN_API_TOKEN: process.env.GREEN_API_TOKEN,
};
