// models/User.js
// Mongoose schema for a Move-On Bot user.
// Each document maps to one WhatsApp chat (identified by chatId).

import mongoose from "mongoose";

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

/**
 * A single message in the stored conversation history.
 * `role` mirrors OpenAI/Groq convention: "user" | "assistant"
 */
const MessageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["user", "assistant"],
      required: true,
    },
    content: {
      type: String,
      required: true,
      trim: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

/**
 * Key-value memory tags extracted silently from user messages.
 * e.g. { "morning_routine": "gym at 7am", "favourite_food": "biryani" }
 */
const MemoryTagSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    value: { type: String, required: true, trim: true },
    extractedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

// ─── Main Schema ──────────────────────────────────────────────────────────────

const UserSchema = new mongoose.Schema(
  {
    /**
     * WhatsApp chatId from Green API, e.g. "919XXXXXXXXX@c.us"
     * Acts as the primary business key.
     */
    chatId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },

    /**
     * Date the user first messaged the bot.
     * Used to derive `daysActive` and the psychological phase.
     */
    createdAt: {
      type: Date,
      default: Date.now,
    },

    /**
     * ISO timestamp of the most recent inbound message.
     * Used for "Cold Shoulder" friction and proactive cron logic.
     */
    last_message_timestamp: {
      type: Date,
      default: null,
    },

    /**
     * Tracks how many proactive messages the bot has sent today
     * so we don't spam the user across all cron slots.
     */
    proactive_sent_today: {
      type: Number,
      default: 0,
    },

    /**
     * Date string (YYYY-MM-DD) of the last proactive send,
     * used to reset `proactive_sent_today` on a new calendar day.
     */
    proactive_last_date: {
      type: String,
      default: null,
    },

    /**
     * Persistent conversation history stored per-user.
     * Capped at MAX_CONTEXT_MESSAGES * 2 entries to prevent unbounded growth.
     */
    conversationHistory: {
      type: [MessageSchema],
      default: [],
    },

    /**
     * Silent memory extracted by `extractShadowMemory`.
     * Injected into system prompt to simulate attentiveness.
     */
    memoryTags: {
      type: [MemoryTagSchema],
      default: [],
    },

    /**
     * Whether the Cold Shoulder friction mode is currently active.
     * Set true when hoursSinceLastMessage > COLD_SHOULDER_HOURS.
     * Reset to false once the user responds and the bot delivers its
     * slow/reluctant reply.
     */
    coldShoulderActive: {
      type: Boolean,
      default: false,
    },

    /**
     * Total messages exchanged (inbound only). Used for engagement
     * metrics and future milestone triggers.
     */
    messageCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true, // adds updatedAt alongside our manual createdAt
    collection: "users",
  }
);

// ─── Virtuals ─────────────────────────────────────────────────────────────────

/**
 * daysActive – number of full days since the user first messaged the bot.
 * Consumed by `calculateRelationshipPhase`.
 */
UserSchema.virtual("daysActive").get(function () {
  const ms = Date.now() - new Date(this.createdAt).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
});

// ─── Instance Methods ─────────────────────────────────────────────────────────

/**
 * Appends a message to history and trims to MAX_CONTEXT_MESSAGES * 2.
 * Call with `await user.addMessage("user"|"assistant", text)` then save.
 */
UserSchema.methods.addMessage = function (role, content, maxMessages = 30) {
  this.conversationHistory.push({ role, content, timestamp: new Date() });
  // Keep only the most recent N messages to bound DB size
  if (this.conversationHistory.length > maxMessages * 2) {
    this.conversationHistory = this.conversationHistory.slice(
      this.conversationHistory.length - maxMessages * 2
    );
  }
};

/**
 * Upsert a memory tag. If the key already exists, overwrite its value.
 */
UserSchema.methods.upsertMemoryTag = function (key, value) {
  const existing = this.memoryTags.find((t) => t.key === key);
  if (existing) {
    existing.value = value;
    existing.extractedAt = new Date();
  } else {
    this.memoryTags.push({ key, value, extractedAt: new Date() });
  }
};

/**
 * Returns a plain-object copy of memoryTags suitable for JSON.stringify
 * injection into the system prompt.
 */
UserSchema.methods.getMemoryMap = function () {
  return this.memoryTags.reduce((acc, tag) => {
    acc[tag.key] = tag.value;
    return acc;
  }, {});
};

/**
 * Resets proactive_sent_today if the last send was on a previous calendar day.
 */
UserSchema.methods.checkAndResetProactiveCount = function () {
  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (this.proactive_last_date !== todayStr) {
    this.proactive_sent_today = 0;
    this.proactive_last_date = todayStr;
  }
};

// ─── Export ───────────────────────────────────────────────────────────────────

const User = mongoose.model("User", UserSchema);
export default User;
