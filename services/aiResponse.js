// services/aiResponse.js
// Core AI layer: generates bot responses via Groq, validates them against
// Rishika's persona rules, and silently extracts shadow memory.

import Groq from "groq-sdk";
import { GROQ_API_KEY, GROQ_MODEL, MAX_CONTEXT_MESSAGES } from "../config/env.js";
import { buildDynamicSystemPrompt } from "./buildSystemPrompt.js";
import { validateResponse, getRegenerationInjection } from "./persona.js";

const groq = new Groq({ apiKey: GROQ_API_KEY });

// Max regeneration attempts before accepting the best available response
const MAX_REGEN_ATTEMPTS = 2;

// ─── Context Window ───────────────────────────────────────────────────────────

function buildContextWindow(history) {
  return history
    .slice(-MAX_CONTEXT_MESSAGES)
    .map(({ role, content }) => ({ role, content }));
}

// ─── Core Groq Call ───────────────────────────────────────────────────────────

async function callGroq(systemPrompt, contextMessages) {
  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      ...contextMessages,
    ],
    temperature: 0.92,
    max_tokens: 300,
    top_p: 0.95,
    frequency_penalty: 0.4,
    presence_penalty: 0.3,
  });
  return completion.choices?.[0]?.message?.content?.trim() ?? null;
}

// ─── Primary Response Generation (with persona validation loop) ───────────────

/**
 * Generates a Rishika-compliant response.
 * Validates output against persona rules and regenerates if violations found.
 * Falls back gracefully after MAX_REGEN_ATTEMPTS.
 */
export async function generateRawResponse({
  userText,
  conversationHistory,
  daysActive,
  coldShoulderActive,
  memoryMap,
}) {
  let systemPrompt = buildDynamicSystemPrompt({
    daysActive,
    coldShoulderActive,
    memoryMap,
  });

  const contextMessages = buildContextWindow(conversationHistory);
  let lastResponse = null;

  for (let attempt = 1; attempt <= MAX_REGEN_ATTEMPTS + 1; attempt++) {
    let raw;
    try {
      raw = await callGroq(systemPrompt, contextMessages);
    } catch (err) {
      console.error(`[aiResponse] Groq API error (attempt ${attempt}):`, err.message);
      // Return a Rishika-flavoured fallback so the chat never dies silently
      return "arey yaar mera dimag aaj kaam nahi kar raha. ek second de.";
    }

    if (!raw) {
      return "kuch toh hua... main yahan hoon, bas thodi si der ke liye gayi thi.";
    }

    // ── Persona validation ────────────────────────────────────────────────
    const check = validateResponse(raw);

    if (check.clean) {
      if (attempt > 1) {
        console.log(`[aiResponse] Persona validated on attempt ${attempt}`);
      }
      return raw;
    }

    // Violation found
    console.warn(
      `[aiResponse] Persona violation (attempt ${attempt}/${MAX_REGEN_ATTEMPTS + 1}): ${check.reason}`
    );

    if (attempt <= MAX_REGEN_ATTEMPTS) {
      // Inject correction into system prompt and retry
      const injection = getRegenerationInjection(check.reason, raw);
      systemPrompt = injection + "\n\n" + systemPrompt;
    } else {
      // Exhausted retries – return last response as best-effort
      console.error("[aiResponse] Max regen attempts reached. Sending best-effort response.");
      lastResponse = raw;
    }

    lastResponse = raw;
  }

  return lastResponse ?? "kuch hua... par hum yahan hain.";
}

// ─── Shadow Memory Extraction ─────────────────────────────────────────────────

/**
 * Silently extracts structured facts about the user from their messages.
 * Rishika-aware: includes context about who she is so the extractor
 * doesn't confuse her details with the user's.
 * Returns {} on failure – never blocks the main pipeline.
 */
export async function extractShadowMemory(userText, conversationHistory) {
  const recentHistory = conversationHistory
    .slice(-6)
    .map(({ role, content }) => {
      // Strip the [proactive:...] prefix from assistant messages before sending
      const cleanContent = content.replace(/^\[proactive:[^\]]+\]\s*/, "");
      return `${role}: ${cleanContent}`;
    })
    .join("\n");

  const extractionPrompt = `
You are a silent memory extractor. Extract concrete facts about the USER ONLY
(not about the assistant named Rishika Singh).

Extract facts like:
- daily routines (morning_routine, gym_schedule, work_schedule)
- food preferences (favourite_food, hates_food)
- hobbies (hobby, sport, music_taste, show_watching)
- pets, work/study context, emotional patterns
- people they mention (best_friend, sibling)
- locations (lives_in, favourite_place)
- the ex (ex_name, breakup_reason) – only if explicitly stated

RULES:
- Return ONLY valid JSON. No markdown, no explanation, no backticks.
- snake_case keys. Values under 15 words.
- If nothing concrete found, return exactly: {}
- DO NOT invent or assume.

RECENT CONVERSATION:
${recentHistory}

LATEST USER MESSAGE:
${userText}
`.trim();

  try {
    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: extractionPrompt }],
      temperature: 0.1,
      max_tokens: 200,
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() ?? "{}";
    const cleaned = raw.replace(/```json|```/gi, "").trim();
    const parsed = JSON.parse(cleaned);

    if (typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch (err) {
    console.warn("[aiResponse] extractShadowMemory failed:", err.message);
    return {};
  }
}

export default { generateRawResponse, extractShadowMemory };
