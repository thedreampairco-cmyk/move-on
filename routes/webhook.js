// routes/webhook.js
// Express router that receives Green API webhook notifications.
// Handles the full inbound message pipeline:
//   1. Parse & validate the payload
//   2. Immediately trigger "composing" chat state
//   3. Upsert user in MongoDB
//   4. Apply Cold Shoulder detection
//   5. Append to conversation history
//   6. Fire shadow memory extraction (non-blocking)
//   7. Generate & humanize bot response
//   8. Persist updated user doc

import express from "express";
import User from "../models/User.js";
import { parseIncomingWebhook, setChatState, sleep } from "../services/greenApi.js";
import { generateRawResponse, extractShadowMemory } from "../services/aiResponse.js";
import { humanizeAndSend } from "../services/humanizer.js";
import { isLocked, acquireLock, releaseLock } from "../services/memoryStore.js";
import { COLD_SHOULDER_HOURS, MAX_CONTEXT_MESSAGES } from "../config/env.js";

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Calculates the number of hours between `lastTimestamp` and now.
 * Returns Infinity if lastTimestamp is null (first ever message).
 *
 * @param {Date|null} lastTimestamp
 * @returns {number}
 */
function hoursSince(lastTimestamp) {
  if (!lastTimestamp) return 0; // First message – no friction
  const ms = Date.now() - new Date(lastTimestamp).getTime();
  return ms / (1000 * 60 * 60);
}

/**
 * Calculates a cold-shoulder opening delay in ms.
 * The bot "takes a moment" before responding after a long absence,
 * mirroring the emotional friction of the cold shoulder.
 * @returns {number} ms to wait (5 000 – 12 000)
 */
function coldShoulderDelay() {
  return 5000 + Math.random() * 7000; // 5–12 seconds
}

// ─── Main Webhook Handler ─────────────────────────────────────────────────────

/**
 * POST /webhook
 *
 * Green API sends all instance notifications here.
 * We respond with 200 immediately (to prevent retries) and process async.
 */
router.post("/", async (req, res) => {
  // Acknowledge receipt immediately – Green API retries on non-2xx
  res.status(200).json({ status: "received" });

  const parsed = parseIncomingWebhook(req.body);
  if (!parsed) {
    // Not a message we handle (status update, media, etc.) – silently ignore
    return;
  }

  const { chatId, text: userText } = parsed;

  // ── Concurrency guard ──────────────────────────────────────────────────────
  // If we're already generating a reply for this chat, drop this message.
  // (Green API can occasionally deliver duplicates)
  if (isLocked(chatId)) {
    console.log(`[webhook] Skipping ${chatId} – already processing.`);
    return;
  }

  acquireLock(chatId);

  try {
    await handleIncomingMessage(chatId, userText);
  } catch (err) {
    console.error(`[webhook] Unhandled error for ${chatId}:`, err);
  } finally {
    releaseLock(chatId);
  }
});

// ─── Core Handler ─────────────────────────────────────────────────────────────

/**
 * Full message processing pipeline for a verified inbound text message.
 *
 * @param {string} chatId
 * @param {string} userText
 */
async function handleIncomingMessage(chatId, userText) {
  // ── Step 1: Instant typing indicator ───────────────────────────────────────
  // Signal "composing" immediately so the user sees we're active.
  // This fires before any async DB work.
  await setChatState(chatId, "composing");

  // ── Step 2: Upsert user document ───────────────────────────────────────────
  let user = await User.findOne({ chatId });

  if (!user) {
    user = new User({ chatId });
    console.log(`[webhook] New user created: ${chatId}`);
  }

  // ── Step 3: Cold Shoulder detection ────────────────────────────────────────
  const hours = hoursSince(user.last_message_timestamp);
  const shouldActivateColdShoulder = hours >= COLD_SHOULDER_HOURS;

  if (shouldActivateColdShoulder && !user.coldShoulderActive) {
    user.coldShoulderActive = true;
    console.log(
      `[webhook] Cold Shoulder activated for ${chatId} (${hours.toFixed(1)}h silence)`
    );
  }

  // ── Step 4: Update engagement stats ────────────────────────────────────────
  user.last_message_timestamp = new Date();
  user.messageCount += 1;

  // ── Step 5: Append user message to history ─────────────────────────────────
  user.addMessage("user", userText, MAX_CONTEXT_MESSAGES);

  // ── Step 6: Shadow memory extraction (non-blocking) ────────────────────────
  // Fire and forget – we save results if they come back before the user doc save
  const memoryPromise = extractShadowMemory(
    userText,
    user.conversationHistory.toObject
      ? user.conversationHistory.toObject()
      : user.conversationHistory
  ).then((extracted) => {
    const entries = Object.entries(extracted);
    if (entries.length > 0) {
      entries.forEach(([key, value]) => {
        if (typeof value === "string" && value.trim()) {
          user.upsertMemoryTag(key, value.trim());
        }
      });
      console.log(
        `[webhook] Shadow memory updated for ${chatId}:`,
        Object.keys(extracted)
      );
    }
  }).catch((err) => {
    console.warn("[webhook] Shadow memory extraction swallowed:", err.message);
  });

  // ── Step 7: Build context for AI call ──────────────────────────────────────
  const daysActive = user.daysActive;
  const coldShoulderActive = user.coldShoulderActive;
  const memoryMap = user.getMemoryMap();

  // If cold shoulder is active, add a brief realistic delay before the bot
  // starts "typing" – simulates reluctant engagement.
  if (coldShoulderActive) {
    const delay = coldShoulderDelay();
    console.log(`[webhook] Cold Shoulder delay: ${Math.round(delay / 1000)}s`);
    await sleep(delay);
    await setChatState(chatId, "composing"); // Re-signal after the gap
  }

  // ── Step 8: Generate AI response ───────────────────────────────────────────
  const rawResponse = await generateRawResponse({
    userText,
    conversationHistory: user.conversationHistory,
    daysActive,
    coldShoulderActive,
    memoryMap,
  });

  // ── Step 9: Append assistant message to history ────────────────────────────
  user.addMessage("assistant", rawResponse, MAX_CONTEXT_MESSAGES);

  // Cold shoulder is resolved after one reply
  user.coldShoulderActive = false;

  // ── Step 10: Await memory extraction (give it up to 3 extra seconds) ───────
  await Promise.race([
    memoryPromise,
    sleep(3000),
  ]);

  // ── Step 11: Persist to DB ─────────────────────────────────────────────────
  await user.save();

  // ── Step 12: Humanize and send ─────────────────────────────────────────────
  await humanizeAndSend(chatId, rawResponse);

  console.log(
    `[webhook] Replied to ${chatId} | Day ${daysActive} | Phase ${getPhaseNumber(daysActive)} | ColdShoulder: ${coldShoulderActive}`
  );
}

/**
 * Quick phase number lookup for logging (mirrors buildSystemPrompt logic).
 * @param {number} daysActive
 * @returns {number}
 */
function getPhaseNumber(daysActive) {
  if (daysActive <= 7) return 1;
  if (daysActive <= 14) return 2;
  if (daysActive <= 21) return 3;
  return 4;
}

export default router;
