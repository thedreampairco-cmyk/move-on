// services/persistentMemory.js
// ═══════════════════════════════════════════════════════════════════════════════
// PERSISTENT MEMORY ENGINE
//
// Survives all code updates, server restarts, and crashes.
// All reads/writes go directly to MongoDB — zero reliance on in-process state.
//
// memoryTags format: plain object { key: value } stored as BSON Object.
// We NEVER use dot-notation $set on memoryTags because old documents may
// still have it as an array until migration runs. Instead we always:
//   1. Read current memoryTags (any format)
//   2. Merge in JS (safe, format-agnostic)
//   3. $set the whole memoryTags object at once
// ═══════════════════════════════════════════════════════════════════════════════

import mongoose from "mongoose";
import User from "../models/User.js";
import { MAX_CONTEXT_MESSAGES } from "../config/env.js";

// ─── MemorySnapshot Schema ────────────────────────────────────────────────────

const MemorySnapshotSchema = new mongoose.Schema(
  {
    chatId:   { type: String, required: true, index: true },
    monthKey: { type: String, required: true },
    messages: [
      {
        role:      { type: String, enum: ["user", "assistant"], required: true },
        content:   { type: String, required: true },
        timestamp: { type: Date, required: true },
      },
    ],
    extractedFacts: { type: Object, default: {} },
    archivedAt:     { type: Date, default: Date.now },
  },
  { collection: "memory_snapshots" }
);

MemorySnapshotSchema.index({ chatId: 1, monthKey: 1 }, { unique: true });

const MemorySnapshot =
  mongoose.models.MemorySnapshot ||
  mongoose.model("MemorySnapshot", MemorySnapshotSchema);

// ─── Constants ────────────────────────────────────────────────────────────────

const HOT_WINDOW_SIZE  = MAX_CONTEXT_MESSAGES * 2; // 30 messages kept hot
const LLM_CONTEXT_SIZE = MAX_CONTEXT_MESSAGES;      // 15 sent to LLM
const ARCHIVE_THRESHOLD = HOT_WINDOW_SIZE + 10;     // archive trigger at 40

// ─── Internal: format-safe memoryTags reader ─────────────────────────────────

/**
 * Reads the raw memoryTags field from a MongoDB document and returns
 * a clean plain object regardless of whether it was stored as:
 *   • A plain object / Mongoose Map  { key: value }      ← new format
 *   • An array of tag objects        [{key, value, ...}] ← legacy format
 *
 * This is the ONLY place that knows about both formats.
 *
 * @param {*} rawField  The raw value of doc.memoryTags
 * @returns {object}    Clean { key: value } object
 */
function normalizeMemoryTags(rawField) {
  if (!rawField) return {};

  // Mongoose Map → plain object
  if (rawField instanceof Map) {
    return Object.fromEntries(rawField);
  }

  // Legacy array [{key, value, extractedAt}, ...]
  if (Array.isArray(rawField)) {
    const obj = {};
    for (const tag of rawField) {
      if (tag?.key && tag?.value) {
        obj[sanitizeKey(String(tag.key))] = String(tag.value).trim();
      }
    }
    return obj;
  }

  // Plain object (already migrated)
  if (typeof rawField === "object") {
    const obj = {};
    for (const [k, v] of Object.entries(rawField)) {
      if (k && v && typeof v === "string") {
        obj[sanitizeKey(k)] = v.trim();
      }
    }
    return obj;
  }

  return {};
}

/**
 * Merges new tags into an existing memoryTags object.
 * New values overwrite old ones for the same key.
 * @param {object} existing
 * @param {object} incoming
 * @returns {object}
 */
function mergeMemoryTags(existing, incoming) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    const clean = sanitizeKey(key);
    if (clean && typeof value === "string" && value.trim()) {
      merged[clean] = value.trim();
    }
  }
  return merged;
}

// ─── Core Read: loadFullContext ───────────────────────────────────────────────

/**
 * Loads everything Rishika needs to reply, from MongoDB.
 * Auto-creates the user document on first message.
 *
 * @param {string} chatId
 * @returns {Promise<{ user, recentHistory, memoryMap, daysActive, coldShoulderActive }>}
 */
export async function loadFullContext(chatId) {
  // Use findOneAndUpdate upsert so first-timers are created atomically
  let user = await User.findOneAndUpdate(
    { chatId },
    { $setOnInsert: { chatId, createdAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Safety net: archive if hot window overflowed
  if (user.conversationHistory.length > ARCHIVE_THRESHOLD) {
    await archiveOldMessages(user);
    user = await User.findOne({ chatId });
  }

  const recentHistory = user.conversationHistory
    .slice(-LLM_CONTEXT_SIZE)
    .map(({ role, content }) => ({ role, content }));

  // Normalize memoryTags regardless of stored format
  const memoryMap = normalizeMemoryTags(user.memoryTags);

  return {
    user,
    recentHistory,
    memoryMap,
    daysActive:         user.daysActive,
    coldShoulderActive: !!user.coldShoulderActive,
  };
}

// ─── Core Write: saveInteraction ─────────────────────────────────────────────

/**
 * Atomically saves both sides of an interaction to MongoDB.
 *
 * memoryTags strategy (crash-safe, format-agnostic):
 *   1. Read current raw memoryTags from DB via lean query
 *   2. normalizeMemoryTags() → clean object regardless of format
 *   3. mergeMemoryTags()     → merge new extracted tags in JS
 *   4. $set whole memoryTags → single atomic write, no dot-notation
 *
 * This works on both old-format (array) and new-format (object) documents.
 *
 * @param {string} chatId
 * @param {string} userText
 * @param {string} botText
 * @param {object} newMemoryTags  { key: value } from shadow memory extraction
 * @param {object} stateUpdates   Optional overrides (coldShoulderActive, etc.)
 */
export async function saveInteraction(
  chatId,
  userText,
  botText,
  newMemoryTags = {},
  stateUpdates  = {}
) {
  const now = new Date();

  // ── Step 1: Fetch raw current tags (lean = plain JS, no Mongoose wrapping)
  const rawDoc = await User.findOne({ chatId }, { memoryTags: 1 }).lean();
  const existingTags = normalizeMemoryTags(rawDoc?.memoryTags);

  // ── Step 2: Merge new tags into existing
  const mergedTags = mergeMemoryTags(existingTags, newMemoryTags);

  // ── Step 3: Single atomic update — messages + tags + state
  await User.findOneAndUpdate(
    { chatId },
    {
      $push: {
        conversationHistory: {
          $each:  [
            { role: "user",      content: userText, timestamp: now },
            { role: "assistant", content: botText,  timestamp: now },
          ],
          $slice: -HOT_WINDOW_SIZE,
        },
      },
      $inc: { messageCount: 1 },
      $set: {
        last_message_timestamp: now,
        coldShoulderActive:     false,
        memoryTags:             mergedTags, // whole object, never dot-notation
        ...stateUpdates,
      },
    },
    { upsert: true }
  );
}

// ─── Proactive Message Saver ──────────────────────────────────────────────────

/**
 * Saves a bot-initiated proactive message (no user side).
 * @param {string} chatId
 * @param {string} botText
 * @param {string} slotName  e.g. "morning_anchor"
 */
export async function saveProactiveMessage(chatId, botText, slotName) {
  const now     = new Date();
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
        last_message_timestamp: now,
        proactive_last_date:    now.toISOString().slice(0, 10),
      },
      $inc: { proactive_sent_today: 1 },
    },
    { upsert: true }
  );
}

// ─── Persist Memory Tags (standalone) ────────────────────────────────────────

/**
 * Updates only the memoryTags field for a chatId.
 * Format-safe: reads current tags, merges, writes whole object.
 * @param {string} chatId
 * @param {object} tags  { key: value }
 */
export async function persistMemoryTags(chatId, tags) {
  if (!tags || Object.keys(tags).length === 0) return;

  const rawDoc = await User.findOne({ chatId }, { memoryTags: 1 }).lean();
  if (!rawDoc) return;

  const existing = normalizeMemoryTags(rawDoc.memoryTags);
  const merged   = mergeMemoryTags(existing, tags);

  await User.findOneAndUpdate(
    { chatId },
    { $set: { memoryTags: merged } },
    { upsert: true }
  );

  console.log(
    `[persistentMemory] Tags updated for ${chatId}: ${Object.keys(tags).join(", ")}`
  );
}

// ─── Archive Old Messages ─────────────────────────────────────────────────────

/**
 * Moves messages older than HOT_WINDOW_SIZE to MemorySnapshot collection.
 * Called automatically when hot window overflows.
 * @param {object} user  Mongoose User document
 */
async function archiveOldMessages(user) {
  const history = user.conversationHistory;
  if (history.length <= HOT_WINDOW_SIZE) return;

  const toArchive = history.slice(0, history.length - HOT_WINDOW_SIZE);
  const toKeep    = history.slice(-HOT_WINDOW_SIZE);
  if (toArchive.length === 0) return;

  // Group by month
  const byMonth = {};
  for (const msg of toArchive) {
    const ts  = msg.timestamp ? new Date(msg.timestamp) : new Date();
    const key = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, "0")}`;
    if (!byMonth[key]) byMonth[key] = [];
    byMonth[key].push({ role: msg.role, content: msg.content, timestamp: ts });
  }

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

  user.conversationHistory = toKeep;
  await user.save();

  console.log(
    `[persistentMemory] Archived ${toArchive.length} msgs for ${user.chatId}. Hot: ${toKeep.length}`
  );
}

// ─── Hydrate Full Memory ──────────────────────────────────────────────────────

/**
 * Returns hot + archived messages and normalised memoryMap.
 * Used for deep context queries and debug reports.
 * @param {string} chatId
 */
export async function hydrateFullMemory(chatId) {
  const user = await User.findOne({ chatId });
  if (!user) return { recentMessages: [], archivedMessages: [], memoryMap: {} };

  const snapshots        = await MemorySnapshot.find({ chatId }).sort({ monthKey: 1 });
  const archivedMessages = snapshots.flatMap((s) => s.messages);

  return {
    recentMessages:  user.conversationHistory.map(({ role, content }) => ({ role, content })),
    archivedMessages,
    memoryMap: normalizeMemoryTags(user.memoryTags),
  };
}

// ─── Relationship State ───────────────────────────────────────────────────────

/**
 * Lightweight state summary for cron jobs.
 * @param {string} chatId
 */
export async function getRelationshipState(chatId) {
  const user = await User.findOne({ chatId }, {
    createdAt: 1, last_message_timestamp: 1, memoryTags: 1,
    proactive_sent_today: 1, proactive_last_date: 1,
  }).lean();

  if (!user) return { daysActive: 0, phase: 1, lastSeen: null, memoryMap: {} };

  const daysActive = Math.floor(
    (Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24)
  );

  const phase =
    daysActive > 21 ? 4 :
    daysActive > 14 ? 3 :
    daysActive > 7  ? 2 : 1;

  return {
    daysActive,
    phase,
    lastSeen:  user.last_message_timestamp,
    memoryMap: normalizeMemoryTags(user.memoryTags),
  };
}

// ─── Debug / Admin ────────────────────────────────────────────────────────────

export async function debugMemoryReport(chatId) {
  const user      = await User.findOne({ chatId }).lean();
  if (!user) { console.log("User not found:", chatId); return; }

  const snapshots      = await MemorySnapshot.find({ chatId }).sort({ monthKey: 1 });
  const totalArchived  = snapshots.reduce((n, s) => n + s.messages.length, 0);
  const memoryMap      = normalizeMemoryTags(user.memoryTags);
  const daysActive     = Math.floor((Date.now() - new Date(user.createdAt)) / 86400000);

  const historyArr = Array.isArray(user.conversationHistory) ? user.conversationHistory : [];

  console.log("\n══════════════════════════════════════════");
  console.log(`  MEMORY REPORT: ${chatId}`);
  console.log("══════════════════════════════════════════");
  console.log(`  Days active   : ${daysActive}`);
  console.log(`  Messages total: ${user.messageCount ?? "?"}`);
  console.log(`  Hot window    : ${historyArr.length} messages`);
  console.log(`  Archived      : ${totalArchived} msgs across ${snapshots.length} month(s)`);
  console.log(`  Memory tags   : ${Object.keys(memoryMap).length}`);
  console.log(`  memoryTags fmt: ${Array.isArray(user.memoryTags) ? "LEGACY ARRAY ⚠️" : "Object ✓"}`);
  console.log("\n  Memory Tags:");
  for (const [k, v] of Object.entries(memoryMap)) {
    console.log(`    ${k}: ${v}`);
  }
  console.log("\n  Last 5 messages:");
  historyArr.slice(-5).forEach((m) =>
    console.log(`    [${m.role}] ${String(m.content).slice(0, 80)}`)
  );
  console.log("══════════════════════════════════════════\n");
}

export async function exportConversation(chatId) {
  const { recentMessages, archivedMessages, memoryMap } = await hydrateFullMemory(chatId);
  return {
    chatId,
    exportedAt:    new Date().toISOString(),
    memoryMap,
    totalMessages: recentMessages.length + archivedMessages.length,
    archived:      archivedMessages,
    recent:        recentMessages,
  };
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function sanitizeKey(key) {
  return String(key)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/__+/g, "_")
    .slice(0, 64);
}

export default {
  loadFullContext,
  saveInteraction,
  saveProactiveMessage,
  persistMemoryTags,
  hydrateFullMemory,
  getRelationshipState,
  debugMemoryReport,
  exportConversation,
  MemorySnapshot,
};
