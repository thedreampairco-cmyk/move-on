// server.js
const express = require('express');
const mongoose = require('mongoose');
const webhookRoutes = require('./routes/webhook');
require('./cronJobs'); // Initializes the background double-texting

const app = express();
app.use(express.json());

// Connect to MongoDB Atlas
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('[Database] MongoDB Connected Successfully'))
    .catch(err => console.error('[Database] MongoDB Connection Error:', err));

// Mount the webhook router
app.use('/webhook', webhookRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Server] Move On Bot is alive on port ${PORT}`);
});
