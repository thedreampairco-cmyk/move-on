const express = require('express');
const mongoose = require('mongoose');
const env = require('./config/env'); 
const webhookRoutes = require('./routes/webhook');
// require('./cronJobs'); // Comment this out temporarily if it's crashing

const app = express();
app.use(express.json());

// 🔴 THE DIAGNOSTIC LOG: This will print your URI to the terminal.
// If it prints "undefined", your .env file is empty or named wrong.
console.log("🚨 DEBUG - MONGO_URI IS:", env.MONGO_URI);

if (!env.MONGO_URI) {
    console.error("❌ FATAL: MONGO_URI is completely missing from your .env file!");
    process.exit(1);
}

// Connect to MongoDB Atlas
mongoose.connect(env.MONGO_URI)
    .then(() => console.log('[Database] MongoDB Memory Vault Connected Successfully'))
    .catch(err => console.error('[Database] MongoDB Connection Error:', err.message));

app.use('/webhook', webhookRoutes);

app.listen(env.PORT, () => {
    console.log(`[Server] Move On Bot is alive on port ${env.PORT}`);
});

