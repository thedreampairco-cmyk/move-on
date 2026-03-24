// server.js
const express = require('express');
const mongoose = require('mongoose');
const env = require('./config/env'); // <-- 1. Import our central environment bridge
const webhookRoutes = require('./routes/webhook');
require('./cronJobs'); // Initializes the background double-texting

const app = express();
app.use(express.json());

// Connect to MongoDB Atlas
// 2. Use the exact variable name from our env.js file
mongoose.connect(env.MONGO_URI)
    .then(() => console.log('[Database] MongoDB Memory Vault Connected Successfully'))
    .catch(err => console.error('[Database] MongoDB Connection Error:', err.message));

// Mount the webhook router
app.use('/webhook', webhookRoutes);

// Start Server
app.listen(env.PORT, () => {
    console.log(`[Server] Move On Bot is alive on port ${env.PORT}`);
});
