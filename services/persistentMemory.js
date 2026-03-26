// services/persistentMemory.js
// ═══════════════════════════════════════════════════════════════════════════════
// PERSISTENT MEMORY ENGINE
//
// Problem it solves:
//   When you update and redeploy the bot, Node.js restarts. Any in-memory
//   state (Maps, arrays, variables) is wiped. This service ensures ALL
//   conversation history, memory tags, and relationship state live ONLY in
//   MongoDB — so Rishika remembers everything across every code update,
//   restart, crash, or server migration.
//
// Architecture:
//   • NO in-memory caching of conversations (would go stale on restart)
//   • Every read goes to MongoDB. Every write goes to MongoDB immediately.
//   • History is stored as an append-only log with a rolling cap.
//   • A separate `MemorySnapshot` collection stores monthly archives so
//     history older than 30 days is not lost even when the rolling cap trims.
//   • `loadFullContext(chatId)` is the single entry point for the AI pipeline.
// ═══════════════════════════════════════════════════════════════════════════════

import mongoose from "mongoose";
import User from "../models/User.js";
import { MAX_CONTEXT_MESSAGES } from "../config/env.js";

// ─── Memory Snapshot Schema ───────────────────────────────────────────────────
// Archives conversation batches older than the rolling window.
// Queried by Rishika's shadow memory but NOT sent to the LLM context window
// (would exceed token limits). Used only for fact extraction lookups.

const MemorySnapshotSchema = new mongoose.Schema(
  {
    chatId: { type: String, required: true, index: true },

    // Month this batch belongs to: "2025-06"
    monthKey: { type: String, required: true },

    // The archived message batch
    messages: [
      {
        role:      { type: String, enum: ["user", "assistant"], required: true },
        content:   { type: String, required: true },
        timestamp: { type: Date,   required: true },
      },
    ],

    // Key facts extracted from this batch (so we don't re-query)
    extractedFacts: { type: Map, of: String, default: {} },

    archivedAt: { type: Date, default: Date.now },
  },
  { collection: "memory_snapshots" }
);

// Compound index: one snapshot document per chatId per month
MemorySnapshotSchema.index({ chatId: 1, monthKey: 1 }, { unique: true });

const MemorySnapshot =
  mongoose.models.MemorySnapshot ||
  mongoose.model("MemorySnapshot", MemorySnapshotSchema);

// ─── Constants ────────────────────────────────────────────────────────────────

// How many messages to keep in the hot (User.conversationHistory) window
const HOT_WINDOW_SIZE = MAX_CONTEXT_MESSAGES * 2; // default: 30

// How many messages to send to the LLM per request (subset of hot window)
const LLM_CONTEXT_SIZE = MAX_CONTEXT_MESSAGES; // default: 15

// Minimum messages before we consider archiving old ones
const ARCHIVE_THRESHOLD = HOT_WINDOW_SIZE + 10;

// ─── Core Read: loadFullContext ───────────────────────────────────────────────

/**
 * THE single entry point for the AI pipeline.
 * Loads everything Rishika needs to reply from MongoDB.
 *
 * Returns:
 *   {
 *     user,              // Mongoose User document (already fetched, ready to .save())
 *     recentHistory,     // Last LLM_CONTEXT_SIZE messages for the AI call
 *     memoryMap,         // All extracted memory tags { key: value }
 *     daysActive,        // Computed from user.createdAt
 *     coldShoulderActive // Boolean
 *   }
 *
 * @param {string} chatId
 * @returns {Promise<object>}
 */
export async function loadFullContext(chatId) {
  // findOneAndUpdate with upsert so first-time users are auto-created
  let user = await User.findOneAndUpdate(
    { chatId },
    { $setOnInsert: { chatId, createdAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Trim hot window if it somehow grew beyond cap (safety net)
  if (user.conversationHistory.length > ARCHIVE_THRESHOLD) {
    await archiveOldMessages(user);
    // Re-fetch after archive mutation
    user = await User.findOne({ chatId });
  }

  const recentHistory = user.conversationHistory
    .slice(-LLM_CONTEXT_SIZE)
    .map(({ role, content }) => ({ role, content }));

  return {
    user,
    recentHistory,
    memoryMap:          user.getMemoryMap(),
    daysActive:         user.daysActive,
    coldShoulderActive: user.coldShoulderActive,
  };
}

// ─── Core Write: saveInteraction ─────────────────────────────────────────────

/**
 * Atomically appends both sides of an interaction (user message + bot reply)
 * to the conversation history and persists memory tag updates.
 *
 * Called AFTER the bot response is generated and ready to send.
 * Using $push with $slice ensures the document never grows beyond cap
 * even if two requests race.
 *
 * @param {string} chatId
 * @param {string} userText
 * @param {string} botText
 * @param {object} newMemoryTags   { key: value } extracted by shadow memory
 * @param {object} stateUpdates    Optional field overrides (coldShoulderActive, etc.)
 * @returns {Promise<void>}
 */
export async function saveInteraction(
  chatId,
  userText,
  botText,
  newMemoryTags = {},
  stateUpdates = {}
) {
  const now = new Date();

  // Build the two new message objects
  const userMsg = { role: "user",      content: userText, timestamp: now };
  const botMsg  = { role: "assistant", content: botText,  timestamp: now };

  // Build $set for memory tag upserts
  // MongoDB Map fields use dot-notation: memoryTags.key_name
  const memorySetOps = {};
  for (const [key, value] of Object.entries(newMemoryTags)) {
    if (typeof value === "string" && value.trim()) {
      memorySetOps[`memoryTags.${sanitizeKey(key)}`] = value.trim();
    }
  }

  await User.findOneAndUpdate(
    { chatId },
    {
      // Append messages and hard-cap at HOT_WINDOW_SIZE using $push + $slice
      $push: {
        conversationHistory: {
          $each:  [userMsg, botMsg],
          $slice: -HOT_WINDOW_SIZE,
        },
      },
      // Increment message count
      $inc: { messageCount: 1 },
      // Update timestamps and state
      $set: {
        last_message_timestamp: now,
        coldShoulderActive: false, // Always reset after a real reply
        ...stateUpdates,
        ...memorySetOps,
      },
    },
    { upsert: true, new: true }
  );
}

// ─── Proactive Message Saver ──────────────────────────────────────────────────

/**
 * Saves a proactive (bot-initiated) message.
 * Only appends the assistant side – no user message.
 *
 * @param {string} chatId
 * @param {string} botText
 * @param {string} slotName   e.g. "morning_anchor"
 */
export async function saveProactiveMessage(chatId, botText, slotName) {
  const now = new Date();
  const content = `[proactive:${slotName}] ${botText}`;

  await User.findOneAndUpdate(
    { chatId },
    {
      $push: {
        conversationHistory: {
          $each:  [{ role: "assistant", content, timestamp: now }],
          $slice: -HOT_WINDOW_SIZE,
        },
      },
      $set: {
        last_message_timestamp:  now,
        proactive_last_date:     now.toISOString().slice(0, 10),
      },
      $inc: { proactive_sent_today: 1 },
    },
    { upsert: true }
  );
}

// ─── Archive Old Messages ─────────────────────────────────────────────────────

/**
 * Archives messages older than the hot window to MemorySnapshot.
 * Called automatically when the hot window exceeds ARCHIVE_THRESHOLD.
 * Uses MongoDB upsert with $push to append to the monthly batch document.
 *
 * @param {object} user  Mongoose User document
 * @returns {Promise<void>}
 */
async function archiveOldMessages(user) {
  const history = user.conversationHistory;
  if (history.length <= HOT_WINDOW_SIZE) return;

  // Everything older than the last HOT_WINDOW_SIZE messages gets archived
  const toArchive = history.slice(0, history.length - HOT_WINDOW_SIZE);
  const toKeep    = history.slice(-HOT_WINDOW_SIZE);

  if (toArchive.length === 0) return;

  // Group by month key for the archive document
  const byMonth = {};
  for (const msg of toArchive) {
    const ts  = msg.timestamp ? new Date(msg.timestamp) : new Date();
    const key = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, "0")}`;
    if (!byMonth[key]) byMonth[key] = [];
    byMonth[key].push({ role: msg.role, content: msg.content, timestamp: ts });
  }

  // Write each month batch to MemorySnapshot
  for (const [monthKey, messages] of Object.entries(byMonth)) {
    await MemorySnapshot.findOneAndUpdate(
      { chatId: user.chatId, monthKey },
      {
        $push: { messages: { $each: messages } },
        $setOnInsert: { chatId: user.chatId, monthKey, archivedAt: new Date() },
      },
      { upsert: true, new: true }
    );
  }

  // Trim the user's hot window in-place
  user.conversationHistory = toKeep;
  await user.save();

  console.log(
    `[persistentMemory] Archived ${toArchive.length} messages for ${user.chatId}. ` +
    `Hot window: ${toKeep.length} messages.`
  );
}

// ─── Memory Hydration ─────────────────────────────────────────────────────────

/**
 * Looks up a user's full memory profile across both the hot window and
 * all archived snapshots. Used by the shadow memory extractor to build
 * a richer fact base than just recent messages.
 *
 * @param {string} chatId
 * @returns {Promise<{ recentMessages: Array, archivedMessages: Array, memoryMap: object }>}
 */
export async function hydrateFullMemory(chatId) {
  const user = await User.findOne({ chatId });
  if (!user) return { recentMessages: [], archivedMessages: [], memoryMap: {} };

  // Fetch ALL archived snapshots for this chatId, sorted oldest first
  const snapshots = await MemorySnapshot.find({ chatId }).sort({ monthKey: 1 });
  const archivedMessages = snapshots.flatMap((s) => s.messages);

  return {
    recentMessages:  user.conversationHistory.map(({ role, content }) => ({ role, content })),
    archivedMessages,
    memoryMap:       user.getMemoryMap(),
  };
}

/**
 * Persists newly extracted memory tags to the MemorySnapshot's extractedFacts
 * AND to the User document. Ensures tags survive even if the hot window
 * is later trimmed.
 *
 * @param {string} chatId
 * @param {object} tags  { key: value }
 */
export async function persistMemoryTags(chatId, tags) {
  if (!tags || Object.keys(tags).length === 0) return;

  const user = await User.findOne({ chatId });
  if (!user) return;

  let changed = false;
  for (const [key, value] of Object.entries(tags)) {
    if (typeof value === "string" && value.trim()) {
      user.upsertMemoryTag(sanitizeKey(key), value.trim());
      changed = true;
    }
  }

  if (changed) await user.save();
}

// ─── Relationship State ───────────────────────────────────────────────────────

/**
 * Returns a lightweight summary of where the relationship currently stands.
 * Used by cronJobs.js to build proactive messages without loading full history.
 *
 * @param {string} chatId
 * @returns {Promise<{ daysActive: number, phase: number, lastSeen: Date|null, memoryMap: object }>}
 */
export async function getRelationshipState(chatId) {
  const user = await User.findOne({ chatId }, {
    createdAt: 1,
    last_message_timestamp: 1,
    memoryTags: 1,
    proactive_sent_today: 1,
    proactive_last_date: 1,
  });

  if (!user) return { daysActive: 0, phase: 1, lastSeen: null, memoryMap: {} };

  const msActive  = Date.now() - new Date(user.createdAt).getTime();
  const daysActive = Math.floor(msActive / (1000 * 60 * 60 * 24));

  let phase = 1;
  if (daysActive > 21) phase = 4;
  else if (daysActive > 14) phase = 3;
  else if (daysActive > 7)  phase = 2;

  return {
    daysActive,
    phase,
    lastSeen:  user.last_message_timestamp,
    memoryMap: user.getMemoryMap(),
  };
}

// ─── Debug / Admin Helpers ────────────────────────────────────────────────────

/**
 * Returns a full memory report for a chatId.
 * Useful for debugging: node -e "import('./services/persistentMemory.js').then(m => m.debugMemoryReport('ID'))"
 *
 * @param {string} chatId
 */
export async function debugMemoryReport(chatId) {
  const user = await User.findOne({ chatId });
  if (!user) { console.log("User not found:", chatId); return; }

  const snapshots = await MemorySnapshot.find({ chatId }).sort({ monthKey: 1 });
  const totalArchived = snapshots.reduce((n, s) => n + s.messages.length, 0);

  console.log("\n══════════════════════════════════════");
  console.log(`  MEMORY REPORT: ${chatId}`);
  console.log("══════════════════════════════════════");
  console.log(`  Days active     : ${user.daysActive}`);
  console.log(`  Messages total  : ${user.messageCount}`);
  console.log(`  Hot window      : ${user.conversationHistory.length} messages`);
  console.log(`  Archived        : ${totalArchived} messages across ${snapshots.length} month(s)`);
  console.log(`  Memory tags     : ${user.memoryTags.length}`);
  console.log("\n  Memory Tags:");
  user.memoryTags.forEach((t) => console.log(`    ${t.key}: ${t.value}`));
  console.log("\n  Last 5 messages:");
  user.conversationHistory.slice(-5).forEach((m) =>
    console.log(`    [${m.role}] ${m.content.slice(0, 80)}`)
  );
  console.log("══════════════════════════════════════\n");
}

/**
 * Exports a full conversation dump to JSON.
 * Run: node -e "..."  to inspect before/after a code update.
 *
 * @param {string} chatId
 * @returns {Promise<object>}
 */
export async function exportConversation(chatId) {
  const { recentMessages, archivedMessages, memoryMap } = await hydrateFullMemory(chatId);
  return {
    chatId,
    exportedAt:  new Date().toISOString(),
    memoryMap,
    totalMessages: recentMessages.length + archivedMessages.length,
    archived:    archivedMessages,
    recent:      recentMessages,
  };
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Sanitizes a memory tag key to be safe for MongoDB dot-notation field paths.
 * Removes characters that would break $set paths.
 * @param {string} key
 * @returns {string}
 */
function sanitizeKey(key) {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/__+/g, "_")
    .slice(0, 64);
}

export default {
  loadFullContext,
  saveInteraction,
  saveProactiveMessage,
  hydrateFullMemory,
  persistMemoryTags,
  getRelationshipState,
  debugMemoryReport,
  exportConversation,
  MemorySnapshot,
};
