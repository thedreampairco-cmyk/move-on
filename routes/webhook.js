// routes/webhook.js

import express from "express";
import { parseIncomingWebhook, setChatState } from "../services/greenApi.js";
import { generateRawResponse, extractShadowMemory } from "../services/aiResponse.js";
import { humanizeAndSend } from "../services/humanizer.js";
import { isLocked, acquireLock, releaseLock } from "../services/memoryStore.js";
import {
  loadFullContext,
  saveInteraction,
  persistMemoryTags,
} from "../services/persistentMemory.js";
import {
  computeInitialDelay,
  incrementRelationshipScore,
  scoreToPhase,
} from "../services/typingDelay.js";
import { COLD_SHOULDER_HOURS } from "../config/env.js";

const router = express.Router();

function hoursSince(ts) {
  if (!ts) return 0;
  return (Date.now() - new Date(ts).getTime()) / (1000 * 60 * 60);
}

router.post("/", async (req, res) => {
  res.status(200).json({ status: "received" });

  const parsed = parseIncomingWebhook(req.body);
  if (!parsed) return;

  const { chatId, text: userText } = parsed;
  if (isLocked(chatId)) return;

  acquireLock(chatId);
  try {
    await handleIncomingMessage(chatId, userText);
  } catch (err) {
    console.error(`[webhook] Error for ${chatId}:`, err);
  } finally {
    releaseLock(chatId);
  }
});

async function handleIncomingMessage(chatId, userText) {
  // 1. Load full context from DB
  const { user, recentHistory, memoryMap, daysActive, coldShoulderActive } =
    await loadFullContext(chatId);

  // 2. Compute initial reply delay NOW (before any async work)
  //    so the clock starts from when she "read" the message
  const initialDelayMs = await computeInitialDelay(user);

  // 3. Show composing immediately (she picked up phone)
  await setChatState(chatId, "composing");

  // 4. Cold shoulder check
  const triggerCold       = hoursSince(user.last_message_timestamp) >= COLD_SHOULDER_HOURS;
  const effectiveColdShoulder = coldShoulderActive || triggerCold;

  // 5. Context window including new user message
  const contextWithNewMsg = [
    ...recentHistory,
    { role: "user", content: userText },
  ];

  // 6. Shadow memory extraction (non-blocking)
  const memoryPromise = extractShadowMemory(userText, contextWithNewMsg)
    .then((tags) => Object.keys(tags).length > 0 && persistMemoryTags(chatId, tags))
    .catch(() => {});

  // 7. Generate response
  const rawResponse = await generateRawResponse({
    userText,
    conversationHistory: contextWithNewMsg,
    daysActive,
    coldShoulderActive: effectiveColdShoulder,
    memoryMap,
  });

  // 8. Save interaction to DB (before send – crash safe)
  const extractedTags = await Promise.race([memoryPromise.then(() =>
    extractShadowMemory(userText, contextWithNewMsg)), new Promise(r => setTimeout(() => r({}), 3000))
  ]).catch(() => ({}));

  await saveInteraction(chatId, userText, rawResponse, extractedTags ?? {}, {
    coldShoulderActive: false,
  });

  // 9. Increment relationship score
  const newScore = await incrementRelationshipScore(chatId);

  // 10. Humanize + send with full Golden Rule timing
  //     Pass the pre-computed initialDelayMs so the delay is not re-computed
  await humanizeAndSend(chatId, rawResponse, user, initialDelayMs);

  console.log(
    `[webhook] ✓ ${chatId} | Day ${daysActive} | Phase ${scoreToPhase(newScore)} | Score ${newScore}`
  );
}

export default router;
