// routes/webhook.js
// Webhook handler – fully wired to persistentMemory for atomic, crash-safe writes.
// History and memory tags survive all code updates and server restarts.

import express from "express";
import { parseIncomingWebhook, setChatState, sleep } from "../services/greenApi.js";
import { generateRawResponse, extractShadowMemory } from "../services/aiResponse.js";
import { humanizeAndSend } from "../services/humanizer.js";
import { isLocked, acquireLock, releaseLock } from "../services/memoryStore.js";
import {
  loadFullContext,
  saveInteraction,
  persistMemoryTags,
} from "../services/persistentMemory.js";
import { COLD_SHOULDER_HOURS } from "../config/env.js";

const router = express.Router();

function hoursSince(lastTimestamp) {
  if (!lastTimestamp) return 0;
  return (Date.now() - new Date(lastTimestamp).getTime()) / (1000 * 60 * 60);
}

function coldShoulderDelay() {
  return 5000 + Math.random() * 7000;
}

// ─── POST /webhook ────────────────────────────────────────────────────────────

router.post("/", async (req, res) => {
  res.status(200).json({ status: "received" });

  const parsed = parseIncomingWebhook(req.body);
  if (!parsed) return;

  const { chatId, text: userText } = parsed;

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

async function handleIncomingMessage(chatId, userText) {
  // 1. Instant typing indicator
  await setChatState(chatId, "composing");

  // 2. Load full context from MongoDB (survives restarts/redeploys)
  const {
    user,
    recentHistory,
    memoryMap,
    daysActive,
    coldShoulderActive,
  } = await loadFullContext(chatId);

  // 3. Cold shoulder detection
  const hours = hoursSince(user.last_message_timestamp);
  const triggerColdShoulder = hours >= COLD_SHOULDER_HOURS && !coldShoulderActive;
  const effectiveColdShoulder = coldShoulderActive || triggerColdShoulder;

  if (triggerColdShoulder) {
    console.log(`[webhook] Cold Shoulder for ${chatId} (${hours.toFixed(1)}h silence)`);
  }

  if (effectiveColdShoulder) {
    const delay = coldShoulderDelay();
    console.log(`[webhook] Cold Shoulder delay: ${Math.round(delay / 1000)}s`);
    await sleep(delay);
    await setChatState(chatId, "composing");
  }

  // 4. Build context window including the new user message
  const contextWithNewMsg = [
    ...recentHistory,
    { role: "user", content: userText },
  ];

  // 5. Shadow memory extraction (non-blocking race)
  const memoryPromise = extractShadowMemory(userText, contextWithNewMsg)
    .then((extracted) => {
      if (Object.keys(extracted).length > 0) {
        return persistMemoryTags(chatId, extracted);
      }
    })
    .catch((err) =>
      console.warn("[webhook] Shadow memory swallowed:", err.message)
    );

  // 6. Generate response
  const rawResponse = await generateRawResponse({
    userText,
    conversationHistory: contextWithNewMsg,
    daysActive,
    coldShoulderActive: effectiveColdShoulder,
    memoryMap,
  });

  // 7. Atomic write to MongoDB – history + state in one operation
  //    This is the line that makes memory survive code updates.
  //    Even if the process crashes after this, the interaction is saved.
  const updatedMemory = await memoryPromise
    .then(() => extractShadowMemory(userText, contextWithNewMsg))
    .catch(() => ({}));

  await saveInteraction(
    chatId,
    userText,
    rawResponse,
    updatedMemory ?? {},
    { coldShoulderActive: false }
  );

  // 8. Send – happens AFTER save so even if send fails, history is intact
  await humanizeAndSend(chatId, rawResponse);

  const phase = daysActive > 21 ? 4 : daysActive > 14 ? 3 : daysActive > 7 ? 2 : 1;
  console.log(
    `[webhook] ✓ ${chatId} | Day ${daysActive} | Phase ${phase} | Cold: ${effectiveColdShoulder}`
  );
}

export default router;
