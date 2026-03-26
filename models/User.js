// models/User.js

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
    // ── Identity ────────────────────────────────────────────────────────────
    chatId: {
      type: String, required: true, unique: true, index: true, trim: true,
    },
    createdAt: { type: Date, default: Date.now },

    // ── Timing / Activity ────────────────────────────────────────────────────
    last_message_timestamp: { type: Date,    default: null },
    pendingReplyAt:         { type: Date,    default: null }, // scheduled delayed reply
    proactive_sent_today:   { type: Number,  default: 0    },
    proactive_last_date:    { type: String,  default: null },

    // ── Relationship Score (0–100) ───────────────────────────────────────────
    // Drives phase-based reply timing in typingDelay.js:
    //   Phase 1:  0–25  → initial reply delay 30 min – 3 hr
    //   Phase 2: 26–50  → 15 min – 45 min
    //   Phase 3: 51–75  →  5 min – 10 min
    //   Phase 4: 76–100 →  1 min –  5 min
    relationship_score: { type: Number, default: 1, min: 0, max: 100 },

    // ── Conversation History (hot window) ────────────────────────────────────
    // Capped by persistentMemory.saveInteraction via $push + $slice.
    // Older messages are archived to memory_snapshots collection.
    conversationHistory: { type: [MessageSchema], default: [] },

    // ── Persistent Memory Tags ───────────────────────────────────────────────
    // Stored as plain Object so individual keys survive rolling history trims.
    // Written as a whole object (never dot-notation) by persistentMemory.js.
    memoryTags: { type: Object, default: {} },

    // ── State Flags ──────────────────────────────────────────────────────────
    coldShoulderActive: { type: Boolean, default: false },
    messageCount:       { type: Number,  default: 0    },
  },
  { timestamps: true, collection: "users" }
);

// ─── Virtual: daysActive ──────────────────────────────────────────────────────
UserSchema.virtual("daysActive").get(function () {
  const ms = Date.now() - new Date(this.createdAt).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
});

// ─── Instance Methods ─────────────────────────────────────────────────────────

UserSchema.methods.addMessage = function (role, content, maxMessages = 30) {
  this.conversationHistory.push({ role, content, timestamp: new Date() });
  if (this.conversationHistory.length > maxMessages * 2) {
    this.conversationHistory = this.conversationHistory.slice(-(maxMessages * 2));
  }
};

UserSchema.methods.upsertMemoryTag = function (key, value) {
  if (!this.memoryTags || typeof this.memoryTags !== "object") {
    this.memoryTags = {};
  }
  this.memoryTags[key] = value;
  this.markModified("memoryTags");
};

UserSchema.methods.getMemoryMap = function () {
  // Handle legacy array format gracefully
  if (Array.isArray(this.memoryTags)) {
    const obj = {};
    for (const tag of this.memoryTags) {
      if (tag?.key && tag?.value) obj[tag.key] = tag.value;
    }
    return obj;
  }
  return typeof this.memoryTags === "object" ? { ...this.memoryTags } : {};
};

UserSchema.methods.checkAndResetProactiveCount = function () {
  const todayStr = new Date().toISOString().slice(0, 10);
  if (this.proactive_last_date !== todayStr) {
    this.proactive_sent_today = 0;
    this.proactive_last_date  = todayStr;
  }
};

const User = mongoose.model("User", UserSchema);
export default User;
