// server.js
const express = require('express');
const webhookRoutes = require('./routes/webhook');
require('./cronJobs'); // Initializes the background double-texting

const app = express();
app.use(express.json());

// Mount the webhook router
app.use('/webhook', webhookRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Server] Move On Bot is alive on port ${PORT}`);
});
