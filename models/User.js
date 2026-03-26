// models/User.js
// Mongoose schema for a Move-On Bot user.
// Memory architecture:
//   • conversationHistory  – rolling hot window (last HOT_WINDOW_SIZE msgs)
//   • memoryTags           – MongoDB Map (key-value facts, survives forever)
//   • Older history        – archived to MemorySnapshot collection by persistentMemory.js

import mongoose from "mongoose";

const MessageSchema = new mongoose.Schema(
  {
    role:      { type: String, enum: ["user", "assistant"], required: true },
    content:   { type: String, required: true, trim: true },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const UserSchema = new mongoose.Schema(
  {
    chatId: {
      type: String, required: true, unique: true, index: true, trim: true,
    },

    createdAt: { type: Date, default: Date.now },

    last_message_timestamp: { type: Date, default: null },

    proactive_sent_today: { type: Number, default: 0 },
    proactive_last_date:  { type: String, default: null },

    // Rolling hot window – capped by persistentMemory.saveInteraction via $slice
    conversationHistory: { type: [MessageSchema], default: [] },

    // ── Persistent Memory Tags ─────────────────────────────────────────────
    // Stored as a MongoDB Map so individual keys can be updated with $set
    // dot-notation without rewriting the entire object.
    // Shape: { morning_routine: "gym at 7am", ex_name: "Rahul", ... }
    // This Map NEVER gets wiped on code updates or restarts.
    memoryTags: {
      type: Map,
      of: String,
      default: {},
    },

    coldShoulderActive: { type: Boolean, default: false },
    messageCount:       { type: Number,  default: 0 },
  },
  { timestamps: true, collection: "users" }
);

// ─── Virtual: daysActive ──────────────────────────────────────────────────────
UserSchema.virtual("daysActive").get(function () {
  const ms = Date.now() - new Date(this.createdAt).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
});

// ─── Instance Methods ─────────────────────────────────────────────────────────

/**
 * Appends a message. Used only for in-memory manipulation before save.
 * The atomic DB path uses persistentMemory.saveInteraction ($push + $slice).
 */
UserSchema.methods.addMessage = function (role, content, maxMessages = 30) {
  this.conversationHistory.push({ role, content, timestamp: new Date() });
  if (this.conversationHistory.length > maxMessages * 2) {
    this.conversationHistory = this.conversationHistory.slice(
      -(maxMessages * 2)
    );
  }
};

/**
 * Upserts a memory tag in the Map field.
 * Works for both Mongoose Map and plain object (handles both cases safely).
 */
UserSchema.methods.upsertMemoryTag = function (key, value) {
  if (this.memoryTags instanceof Map) {
    this.memoryTags.set(key, value);
  } else {
    this.memoryTags[key] = value;
  }
  this.markModified("memoryTags");
};

/**
 * Returns a plain { key: value } object for prompt injection.
 * Works whether memoryTags is a Mongoose Map or plain object.
 */
UserSchema.methods.getMemoryMap = function () {
  if (this.memoryTags instanceof Map) {
    return Object.fromEntries(this.memoryTags);
  }
  return { ...this.memoryTags };
};

/**
 * Resets proactive_sent_today if it's a new calendar day.
 */
UserSchema.methods.checkAndResetProactiveCount = function () {
  const todayStr = new Date().toISOString().slice(0, 10);
  if (this.proactive_last_date !== todayStr) {
    this.proactive_sent_today = 0;
    this.proactive_last_date = todayStr;
  }
};

const User = mongoose.model("User", UserSchema);
export default User;
