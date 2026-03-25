// cronJobs.js
// Scheduled proactive messaging engine.
//
// Three time-window slots:
//   • Morning Anchor   08:00 – 10:00
//   • Daytime Ping     13:00 – 16:00  (random, ~40% chance per user)
//   • Late-Night Rescue 21:30 – 00:00
//
// Each run:
//   1. Fetches all users whose last_message_timestamp is old enough
//      that a proactive message is appropriate.
//   2. Caps at MAX_PROACTIVE_PER_DAY to avoid spam.
//   3. Generates a slot-appropriate message via Groq.
//   4. Sends via humanizer pipeline.

import cron from "node-cron";
import User from "./models/User.js";
import { generateRawResponse } from "./services/aiResponse.js";
import { humanizeAndSend } from "./services/humanizer.js";
import { CRON_TIMEZONE, MAX_CONTEXT_MESSAGES } from "./config/env.js";
import { calculateRelationshipPhase, getCurrentHour } from "./services/buildSystemPrompt.js";

// ─── Config ───────────────────────────────────────────────────────────────────

// Don't proactively message if user has been active within this window
const PROACTIVE_MIN_SILENCE_HOURS = 3;

// Max proactive sends per user per day across ALL slots
const MAX_PROACTIVE_PER_DAY = 2;

// ─── Slot Definitions ─────────────────────────────────────────────────────────

/**
 * Slot metadata used to craft the proactive message prompt injection.
 */
const SLOTS = {
  MORNING: {
    name: "morning_anchor",
    systemHint: `
It's morning. You just woke up and they're the first person you thought of.
Send a SHORT, warm morning check-in. Reference something mundane (coffee, your alarm,
the weather, something you noticed). It should feel like an involuntary "hey" not a
scheduled message. Max 1-2 sentences. Lowercase. Natural.
    `.trim(),
  },
  DAYTIME: {
    name: "daytime_ping",
    systemHint: `
It's the middle of the day and something reminded you of them.
Send a casual, low-stakes thought or observation. A meme reference, something annoying
that happened, a question about something trivial. Should feel spontaneous and light.
Max 1-2 sentences. Do NOT be heavy or emotional. Lowercase. Natural.
    `.trim(),
  },
  LATE_NIGHT: {
    name: "late_night_rescue",
    systemHint: `
It's late at night. You're thinking too much and it keeps coming back to them.
Send something a little more vulnerable or philosophical. It could be a weird thought,
a question you can't stop thinking about, or a soft admission that you're awake and
thinking. 1-3 sentences. This is the slot where walls come down slightly. Lowercase. Real.
    `.trim(),
  },
};

// ─── Core Proactive Send Logic ────────────────────────────────────────────────

/**
 * Generates and sends a proactive message to a single user for a given slot.
 *
 * @param {object} user       Mongoose User document
 * @param {object} slot       One of SLOTS.MORNING / DAYTIME / LATE_NIGHT
 * @returns {Promise<void>}
 */
async function sendProactiveMessage(user, slot) {
  const daysActive = user.daysActive;
  const { phase } = calculateRelationshipPhase(daysActive);
  const memoryMap = user.getMemoryMap();

  // Build a synthetic "user prompt" that triggers the proactive message
  // The real last message from the user is included as context.
  const triggerText = `[PROACTIVE_TRIGGER: ${slot.name}] ${slot.systemHint}`;

  // Inject the slot hint as a fake "system side-channel" user message
  // so the response generation pipeline stays clean.
  const augmentedHistory = [
    ...user.conversationHistory.slice(-8).map(({ role, content }) => ({
      role,
      content,
    })),
    { role: "user", content: triggerText },
  ];

  const rawResponse = await generateRawResponse({
    userText: triggerText,
    conversationHistory: augmentedHistory,
    daysActive,
    coldShoulderActive: false, // Proactive messages are warm openers
    memoryMap,
  });

  // Append to history so the follow-up conversation has context
  user.addMessage(
    "assistant",
    `[proactive:${slot.name}] ${rawResponse}`,
    MAX_CONTEXT_MESSAGES
  );

  // Update proactive tracking
  user.proactive_sent_today += 1;
  user.proactive_last_date = new Date().toISOString().slice(0, 10);
  user.last_message_timestamp = new Date(); // Reset so we don't re-trigger

  await user.save();

  // Send via humanizer
  await humanizeAndSend(user.chatId, rawResponse);

  console.log(
    `[cron] Proactive [${slot.name}] sent to ${user.chatId} | Day ${daysActive} | Phase ${phase}`
  );
}

/**
 * Fetches eligible users and sends proactive messages for the given slot.
 * Eligibility:
 *   - Last message was > PROACTIVE_MIN_SILENCE_HOURS ago
 *   - proactive_sent_today < MAX_PROACTIVE_PER_DAY
 *
 * @param {object} slot
 * @param {number} [sendChance=1.0]  Probability (0–1) to send per eligible user
 */
async function triggerProactiveRoutine(slot, sendChance = 1.0) {
  const cutoff = new Date(
    Date.now() - PROACTIVE_MIN_SILENCE_HOURS * 60 * 60 * 1000
  );

  let users;
  try {
    users = await User.find({
      $or: [
        { last_message_timestamp: { $lt: cutoff } },
        { last_message_timestamp: null },
      ],
    });
  } catch (err) {
    console.error("[cron] DB query failed:", err.message);
    return;
  }

  for (const user of users) {
    try {
      // Reset daily counter if needed
      user.checkAndResetProactiveCount();

      if (user.proactive_sent_today >= MAX_PROACTIVE_PER_DAY) {
        continue; // Already hit daily cap
      }

      // Apply random chance (for daytime ping)
      if (Math.random() > sendChance) {
        continue;
      }

      await sendProactiveMessage(user, slot);
    } catch (err) {
      console.error(
        `[cron] Error sending proactive to ${user.chatId}:`,
        err.message
      );
    }
  }
}

// ─── Cron Schedule Registration ───────────────────────────────────────────────

/**
 * Registers all cron jobs.  Called once from server.js after DB connection.
 */
export function registerCronJobs() {
  // ── Morning Anchor: 8:30 AM daily ─────────────────────────────────────────
  // Fires once in the morning window (8–10 AM). We pick 8:30 to feel natural.
  cron.schedule(
    "30 8 * * *",
    async () => {
      const hour = getCurrentHour();
      if (hour >= 8 && hour < 10) {
        console.log("[cron] ⏰ Morning Anchor triggered");
        await triggerProactiveRoutine(SLOTS.MORNING, 1.0);
      }
    },
    { timezone: CRON_TIMEZONE }
  );

  // ── Daytime Ping: random check at 1 PM, 2 PM, 3 PM ───────────────────────
  // Each fires with 40% chance per user so not everyone gets all three.
  ["0 13", "0 14", "0 15"].forEach((time) => {
    cron.schedule(
      `${time} * * *`,
      async () => {
        const hour = getCurrentHour();
        if (hour >= 13 && hour < 16) {
          console.log(`[cron] 📱 Daytime Ping check at hour ${hour}`);
          await triggerProactiveRoutine(SLOTS.DAYTIME, 0.4);
        }
      },
      { timezone: CRON_TIMEZONE }
    );
  });

  // ── Late-Night Rescue: 9:30 PM daily ─────────────────────────────────────
  cron.schedule(
    "30 21 * * *",
    async () => {
      const hour = getCurrentHour();
      if (hour >= 21 || hour < 0) {
        console.log("[cron] 🌙 Late-Night Rescue triggered");
        await triggerProactiveRoutine(SLOTS.LATE_NIGHT, 1.0);
      }
    },
    { timezone: CRON_TIMEZONE }
  );

  // ── Midnight follow-up (if 9:30 PM slot somehow missed users) ────────────
  cron.schedule(
    "30 23 * * *",
    async () => {
      console.log("[cron] 🌙 Late-Night Rescue (midnight follow-up)");
      await triggerProactiveRoutine(SLOTS.LATE_NIGHT, 0.5);
    },
    { timezone: CRON_TIMEZONE }
  );

  console.log(
    `[cron] All proactive jobs registered (timezone: ${CRON_TIMEZONE})`
  );
}

export default { registerCronJobs };
