// models/User.js
const mongoose = require('mongoose');

// Define the structure for individual messages in the sliding window
const messageSchema = new mongoose.Schema({
    role: {
        type: String,
        enum: ['user', 'assistant', 'system'],
        required: true
    },
    content: {
        type: String,
        required: true
    },
    timestamp: {
        type: Date,
        default: Date.now
    }
}, { _id: false }); // Disables unique IDs for subdocuments to keep the database lean

// Define the main User profile
const userSchema = new mongoose.Schema({
    chatId: {
        type: String,
        required: true,
        unique: true,
        index: true // CRITICAL: Speeds up the webhook lookups immensely
    },
    userName: {
        type: String,
        default: 'there' // Fallback if we haven't extracted his name yet
    },
    coreMemories: {
        type: [String], // Array of strings (e.g., ["His ex is Priya", "He likes dogs"])
        default: []
    },
    chatHistory: {
        type: [messageSchema],
        default: []
    },
    lastActiveTimestamp: {
        type: Date,
        default: Date.now,
    closenessScore: { type: Number, default: 0 },
    lastInteraction: { type: Date, default: Date.now }
}

}, { 
    timestamps: true // Automatically adds createdAt and updatedAt fields
});

module.exports = mongoose.model('User', userSchema);
