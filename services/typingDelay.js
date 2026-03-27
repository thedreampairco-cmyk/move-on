// services/typingDelay.js
// ═══════════════════════════════════════════════════════════════════════════════
// REALISTIC TYPING DELAY ENGINE (TESTING MODE ACTIVE)
//
// Implements the Golden Rule delay sequence:
//   1. Reading Phase  : 1–2s  (Testing)
//   2. Typing Phase   : 1-3s total  (Testing)
//
// Plus Phase-aware Initial Reply Delays (first message after a gap):
//   Phase 1 (score  0–25): 30 min – 3 hrs
//   Phase 2 (score 26–50): 15 min – 45 min
//   Phase 3 (score 51–75):  5 min – 10 min
//   Phase 4 (score 76–100): 1 min –  5 min
// ═══════════════════════════════════════════════════════════════════════════════

import User from "../models/User.js";
import { setChatState, sleep, sendTextMessage } from "./greenApi.js";

// ─── Constants (TESTING MODE) ─────────────────────────────────────────────────

const READING_PHASE_MIN_MS  = 1_000; // 1 second
const READING_PHASE_MAX_MS  = 2_000; // 2 seconds

// Make typing fast and prevent multiplication for long texts
const TYPING_PER_CHUNK_MIN_MS = 1_000; // 1 second
const TYPING_PER_CHUNK_MAX_MS = 3_000; // 3 seconds
const CHARS_PER_CHUNK         = 1000;  // High enough to always count as 1 chunk

// Green API typing indicator refreshes every N ms to keep the "typing..." alive
const TYPING_REFRESH_INTERVAL_MS = 4_000;

// Minimum silence gap (ms) before an "initial reply delay" applies.
const ACTIVE_CHAT_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// Phase 1 active-chat inner delay: she puts the phone down mid-convo
const PHASE1_ACTIVE_PAUSE_MIN_MS =  90_000; // 1.5 min
const PHASE1_ACTIVE_PAUSE_MAX_MS = 180_000; // 3 min

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a random integer between min and max (inclusive).
 */
function randBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Returns a random float between min and max.
 */
function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}

/**
 * Converts milliseconds to a human-readable string for logging.
 */
function msToStr(ms) {
  if (ms < 1000)    return `${ms}ms`;
  if (ms < 60_000)  return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

// ─── Relationship Score → Phase ───────────────────────────────────────────────

/**
 * Maps a relationship_score (0–100) to a phase number (1–4).
 * @param {number} score
 * @returns {1|2|3|4}
 */
export function scoreToPhase(score) {
  if (score <= 25) return 1;
  if (score <= 50) return 2;
  if (score <= 75) return 3;
  return 4;
}

/**
 * Returns the initial reply delay range in ms for a given score.
 * Applied only when hoursSinceLastMessage > ACTIVE_CHAT_THRESHOLD.
 *
 * @param {number} score  0–100
 * @returns {{ minMs: number, maxMs: number, label: string }}
 */
export function getInitialReplyDelayRange(score) {
  const phase = scoreToPhase(score);
  const ranges = {
    1: { minMs: 3_000,  maxMs: 30_000, label: "3–30 sec (TEST)"  },
    2: { minMs: 15 * 60_000,  maxMs:  45 * 60_000, label: "15–45 min"    },
    3: { minMs:  5 * 60_000,  maxMs:  10 * 60_000, label: "5–10 min"     },
    4: { minMs:  1 * 60_000,  maxMs:   5 * 60_000, label: "1–5 min"      },
  };
  return ranges[phase];
}

// ─── Typing Duration Calculator ───────────────────────────────────────────────

/**
 * Calculates how long the "typing..." indicator should show for a given
 * reply text using the Golden Rule formula:
 * • Divide text into chunks (Currently set to 1000 chars for testing)
 * • Each chunk = random 1-3 seconds
 *
 * @param {string} text  The bot's reply text
 * @returns {{ totalMs: number, chunks: number, perChunkMs: number[] }}
 */
export function calculateTypingDuration(text) {
  const charCount = (text ?? "").length;
  const chunks    = Math.max(1, Math.ceil(charCount / CHARS_PER_CHUNK));

  const perChunkMs = Array.from({ length: chunks }, () =>
    randBetween(TYPING_PER_CHUNK_MIN_MS, TYPING_PER_CHUNK_MAX_MS)
  );

  const totalMs = perChunkMs.reduce((s, v) => s + v, 0);
  return { totalMs, chunks, perChunkMs };
}

/**
 * Calculates the reading phase delay.
 * @returns {number} ms
 */
export function calculateReadingDelay() {
  return randBetween(READING_PHASE_MIN_MS, READING_PHASE_MAX_MS);
}

// ─── Phase 4: Preemptive "Going offline" notice ───────────────────────────────

/**
 * Generates a short preemptive notice message Rishika sends before going
 * into a long study session (Phase 4 only, triggered randomly ~20% of the time
 * when an initial reply delay > 30 min is computed).
 *
 * The actual long delay still runs — this just tells the user she'll be back.
 *
 * @param {number} delayMs   The computed initial reply delay in ms
 * @returns {string|null}    The notice text, or null if not applicable
 */
export function buildPreemptiveNotice(delayMs) {
  const delayMin = Math.round(delayMs / 60_000);

  const notices = [
    `sitting for a ${delayMin}-minute mock test now. will be back after. don't disappear.`,
    `just starting a study session. ${delayMin} minutes, then i'm all yours.`,
    `phone going on DND for a bit. ${delayMin} mins max. miss you already haha`,
    `arey, about to sit for current affairs. won't be long – ${delayMin} mins.`,
    `giving myself a ${delayMin}-minute focus block. come back to you after, promise.`,
  ];

  return notices[Math.floor(Math.random() * notices.length)];
}

// ─── Initial Reply Delay Scheduler ───────────────────────────────────────────

/**
 * Determines whether an initial reply delay should fire, and if so how long.
 * Writes a `pendingReplyAt` timestamp to the user doc and returns the delay ms.
 *
 * "Initial reply delay" only applies when the user is re-opening a cold chat
 * (last message was > ACTIVE_CHAT_THRESHOLD_MS ago).
 *
 * If active chat (within threshold):
 * - Phase 1: occasional 1.5–3 min pause (she put the phone down)
 * - Phase 2–4: no extra delay beyond reading + typing formula
 *
 * @param {object} user       Mongoose User document
 * @param {number} nowMs      Date.now()
 * @returns {Promise<number>} ms to wait before starting reading phase
 */
export async function computeInitialDelay(user, nowMs = Date.now()) {
  const score = user.relationship_score ?? 1;
  const lastMsgTime = user.last_message_timestamp
    ? new Date(user.last_message_timestamp).getTime()
    : 0;

  const msSinceLastMsg = nowMs - lastMsgTime;
  const isColdChat     = msSinceLastMsg > ACTIVE_CHAT_THRESHOLD_MS;

  if (!isColdChat) {
    // Active conversation
    if (scoreToPhase(score) === 1) {
      // Phase 1: she puts the phone down mid-convo sometimes
      if (Math.random() < 0.4) { // 40% chance of a pause
        const pause = randBetween(PHASE1_ACTIVE_PAUSE_MIN_MS, PHASE1_ACTIVE_PAUSE_MAX_MS);
        console.log(`[typingDelay] Phase 1 active-chat pause: ${msToStr(pause)}`);
        return pause;
      }
    }
    return 0; // All other phases: no extra delay in active chat
  }

  // Cold chat – apply phase-based initial reply delay
  const { minMs, maxMs, label } = getInitialReplyDelayRange(score);
  const delay = randBetween(minMs, maxMs);

  console.log(
    `[typingDelay] Cold chat | Score ${score} (Phase ${scoreToPhase(score)}) | ` +
    `Initial reply delay: ${msToStr(delay)} (range: ${label})`
  );

  return delay;
}

// ─── Core: Full Delay + Send Orchestrator ────────────────────────────────────

/**
 * The single entry point called by the webhook handler and cron jobs.
 * Executes the complete Golden Rule sequence for ONE text fragment:
 *
 * [initial reply delay if cold chat]
 * ↓
 * [reading phase: 1–2s silence (TESTING)]
 * ↓
 * [typing phase: setChatState("composing") for calculated duration]
 * ↓
 * [sendTextMessage]
 *
 * For multi-fragment messages (double texts), call this per fragment.
 * The first fragment uses the full initial delay; subsequent fragments
 * use a short inter-fragment gap (1.5–3.5s) instead.
 *
 * @param {object}  params
 * @param {string}  params.chatId
 * @param {string}  params.text          The text to send
 * @param {object}  params.user          Mongoose User document
 * @param {boolean} params.isFirstFragment  Apply initial delay only on first
 * @param {number}  params.initialDelayMs   Pre-computed delay (pass 0 to skip)
 * @returns {Promise<string|null>}       Green API idMessage or null
 */
export async function delayAndSend({
  chatId,
  text,
  user,
  isFirstFragment = true,
  initialDelayMs  = -1,
}) {
  const score = user?.relationship_score ?? 1;

  // ── Step 1: Initial reply delay (cold chat / phase-based) ─────────────────
  if (isFirstFragment) {
    const delay = initialDelayMs >= 0
      ? initialDelayMs
      : await computeInitialDelay(user);

    if (delay > 0) {
      // Phase 4: send preemptive notice if delay > 20 min and 20% chance
      if (scoreToPhase(score) === 4 && delay > 20 * 60_000 && Math.random() < 0.2) {
        const notice = buildPreemptiveNotice(delay);
        await sendTextMessage(chatId, notice);
        console.log(`[typingDelay] Phase 4 preemptive notice sent to ${chatId}`);
      }

      console.log(`[typingDelay] Waiting initial delay: ${msToStr(delay)}`);
      await sleep(delay);
    }
  } else {
    // Inter-fragment gap for double texts
    const gap = randBetween(1_500, 3_500);
    await sleep(gap);
  }

  // ── Step 2: Reading phase – silence before typing indicator ───────────────
  const readingDelay = calculateReadingDelay();
  console.log(`[typingDelay] Reading phase: ${msToStr(readingDelay)}`);
  await sleep(readingDelay);

  // ── Step 3: Typing phase – show indicator for calculated duration ─────────
  const { totalMs, chunks } = calculateTypingDuration(text);
  console.log(
    `[typingDelay] Typing phase: ${msToStr(totalMs)} (${chunks} chunk${chunks !== 1 ? "s" : ""})`
  );

  // Keep refreshing the typing indicator every TYPING_REFRESH_INTERVAL_MS
  // so WhatsApp doesn't drop it during long responses
  let elapsed = 0;
  await setChatState(chatId, "composing");

  while (elapsed < totalMs) {
    const remaining = totalMs - elapsed;
    const tick      = Math.min(TYPING_REFRESH_INTERVAL_MS, remaining);
    await sleep(tick);
    elapsed += tick;
    if (elapsed < totalMs) {
      await setChatState(chatId, "composing"); // re-ping to keep indicator alive
    }
  }

  // ── Step 4: Send ──────────────────────────────────────────────────────────
  const idMessage = await sendTextMessage(chatId, text);
  console.log(
    `[typingDelay] ✓ Sent to ${chatId}: "${text.slice(0, 40)}${text.length > 40 ? "…" : ""}"`
  );
  return idMessage;
}

// ─── Relationship Score Updater ───────────────────────────────────────────────

/**
 * Increments the relationship_score after each interaction.
 * Score is capped at 100. Progression rules:
 * Phase 1 (0–25):  +1 per message exchange
 * Phase 2 (26–50): +0.7 per exchange (slower – she's assessing)
 * Phase 3 (51–75): +0.5 per exchange (deep comfort, slower movement)
 * Phase 4 (76+):   +0.2 per exchange (nearly stable)
 *
 * @param {string} chatId
 * @returns {Promise<number>} New score
 */
export async function incrementRelationshipScore(chatId) {
  const user = await User.findOne({ chatId }, { relationship_score: 1 });
  if (!user) return 1;

  const current = user.relationship_score ?? 1;
  const phase   = scoreToPhase(current);
  const increments = { 1: 1.0, 2: 0.7, 3: 0.5, 4: 0.2 };
  const delta   = increments[phase] ?? 0.2;
  const next    = Math.min(100, parseFloat((current + delta).toFixed(2)));

  await User.findOneAndUpdate({ chatId }, { $set: { relationship_score: next } });

  if (scoreToPhase(current) !== scoreToPhase(next)) {
    console.log(
      `[typingDelay] 🎉 Phase transition for ${chatId}: ` +
      `Phase ${scoreToPhase(current)} → Phase ${scoreToPhase(next)} (score: ${next})`
    );
  }

  return next;
}

export default {
  scoreToPhase,
  getInitialReplyDelayRange,
  calculateTypingDuration,
  calculateReadingDelay,
  computeInitialDelay,
  buildPreemptiveNotice,
  delayAndSend,
  incrementRelationshipScore,
};
