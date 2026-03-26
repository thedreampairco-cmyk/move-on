// cronJobs.js – Proactive messaging engine, wired to persistentMemory.

import cron from "node-cron";
import User from "./models/User.js";
import { generateRawResponse } from "./services/aiResponse.js";
import { humanizeAndSend } from "./services/humanizer.js";
import { saveProactiveMessage, getRelationshipState } from "./services/persistentMemory.js";
import { CRON_TIMEZONE } from "./config/env.js";
import { getCurrentHour } from "./services/buildSystemPrompt.js";

const PROACTIVE_MIN_SILENCE_HOURS = 3;
const MAX_PROACTIVE_PER_DAY = 2;

const SLOTS = {
  MORNING: {
    name: "morning_anchor",
    hint: "It's morning. You just woke up and they're the first thought. Send a short, warm, involuntary 'hey'. Reference something mundane – chai, your alarm, the Jaipur winter chill. 1–2 sentences max. Lowercase. Real.",
  },
  DAYTIME: {
    name: "daytime_ping",
    hint: "Middle of the day. Something reminded you of them mid-study-session. Send a casual, low-stakes observation or question. Spontaneous and light. Not emotional. 1 sentence. Lowercase.",
  },
  LATE_NIGHT: {
    name: "late_night_rescue",
    hint: "It's late. Talwinder is playing. You're thinking too much and it keeps coming back to them. Send something a little vulnerable or philosophical. 1–3 sentences. Walls down slightly. Lowercase. Real.",
  },
};

async function sendProactiveMessage(user, slot) {
  const { daysActive, memoryMap } = await getRelationshipState(user.chatId);

  const triggerMsg = `[PROACTIVE_TRIGGER: ${slot.name}]\n${slot.hint}`;
  const contextWindow = user.conversationHistory
    .slice(-8)
    .map(({ role, content }) => ({ role, content }));
  contextWindow.push({ role: "user", content: triggerMsg });

  const rawResponse = await generateRawResponse({
    userText:            triggerMsg,
    conversationHistory: contextWindow,
    daysActive,
    coldShoulderActive:  false,
    memoryMap,
  });

  // Persist before sending – history is safe even if WhatsApp delivery fails
  await saveProactiveMessage(user.chatId, rawResponse, slot.name);
  await humanizeAndSend(user.chatId, rawResponse, user, 0); // proactive = no initial delay

  console.log(`[cron] ✓ Proactive [${slot.name}] → ${user.chatId} | Day ${daysActive}`);
}

async function triggerProactiveRoutine(slot, sendChance = 1.0) {
  const cutoff = new Date(
    Date.now() - PROACTIVE_MIN_SILENCE_HOURS * 60 * 60 * 1000
  );

  const users = await User.find({
    $or: [
      { last_message_timestamp: { $lt: cutoff } },
      { last_message_timestamp: null },
    ],
  }).catch((err) => {
    console.error("[cron] DB query failed:", err.message);
    return [];
  });

  for (const user of users) {
    try {
      user.checkAndResetProactiveCount();
      if (user.proactive_sent_today >= MAX_PROACTIVE_PER_DAY) continue;
      if (Math.random() > sendChance) continue;
      await sendProactiveMessage(user, slot);
    } catch (err) {
      console.error(`[cron] Error → ${user.chatId}:`, err.message);
    }
  }
}

export function registerCronJobs() {
  // Morning Anchor – 8:30 AM
  cron.schedule("30 8 * * *", async () => {
    const h = getCurrentHour();
    if (h >= 8 && h < 10) {
      console.log("[cron] ⏰ Morning Anchor");
      await triggerProactiveRoutine(SLOTS.MORNING, 1.0);
    }
  }, { timezone: CRON_TIMEZONE });

  // Daytime Ping – 1 PM, 2 PM, 3 PM (40% each)
  for (const time of ["0 13", "0 14", "0 15"]) {
    cron.schedule(`${time} * * *`, async () => {
      const h = getCurrentHour();
      if (h >= 13 && h < 16) {
        console.log(`[cron] 📱 Daytime Ping (hour ${h})`);
        await triggerProactiveRoutine(SLOTS.DAYTIME, 0.4);
      }
    }, { timezone: CRON_TIMEZONE });
  }

  // Late-Night Rescue – 9:30 PM + midnight follow-up
  cron.schedule("30 21 * * *", async () => {
    console.log("[cron] 🌙 Late-Night Rescue");
    await triggerProactiveRoutine(SLOTS.LATE_NIGHT, 1.0);
  }, { timezone: CRON_TIMEZONE });

  cron.schedule("30 23 * * *", async () => {
    console.log("[cron] 🌙 Late-Night Rescue (follow-up)");
    await triggerProactiveRoutine(SLOTS.LATE_NIGHT, 0.5);
  }, { timezone: CRON_TIMEZONE });

  console.log(`[cron] All jobs registered (tz: ${CRON_TIMEZONE})`);
}

export default { registerCronJobs };
