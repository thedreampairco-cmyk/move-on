// server.js
const express = require('express');
const mongoose = require('mongoose');
const env = require('./config/env');
const webhookRoutes = require('./routes/webhook');

const app = express();
app.use(express.json());

// 🕵️ THE RENDER CONFESSION LOG: 
// This will print out the NAMES of the variables Render is actually providing.
const safeKeys = Object.keys(process.env).filter(k => 
    k.includes('MONGO') || k.includes('GROQ') || k.includes('GREEN')
);
console.log("🚨 DETECTED CLOUD KEYS:", safeKeys);
console.log("🚨 env.js MONGO_URI IS:", env.MONGO_URI ? "HIDDEN_BUT_EXISTS" : "undefined");

if (!env.MONGO_URI) {
    console.error("❌ FATAL: The code still cannot see the MONGO_URI!");
    process.exit(1);
}

// Connect to MongoDB Atlas
mongoose.connect(env.MONGO_URI)
    .then(() => console.log('[Database] MongoDB Memory Vault Connected Successfully'))
    .catch(err => console.error('[Database] MongoDB Connection Error:', err.message));

// Health Check Route (Click this in your browser)
app.get('/', (req, res) => {
    res.status(200).send("✅ Move-On Bot is Live and Reachable on the internet!");
});

app.use('/webhook', webhookRoutes);

app.listen(env.PORT, () => {
    console.log(`[Server] Move On Bot is alive on port ${env.PORT}`);
});
