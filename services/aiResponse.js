// services/aiResponse.js
// Core AI layer: generates bot responses via Groq and silently
// extracts memory tags from user messages in the background.

import Groq from "groq-sdk";
import {
  GROQ_API_KEY,
  GROQ_MODEL,
  MAX_CONTEXT_MESSAGES,
} from "../config/env.js";
import { buildDynamicSystemPrompt } from "./buildSystemPrompt.js";

// ─── Groq Client ──────────────────────────────────────────────────────────────

const groq = new Groq({ apiKey: GROQ_API_KEY });

// ─── Context Window Builder ───────────────────────────────────────────────────

/**
 * Converts the stored conversationHistory array into the clean
 * { role, content } format expected by Groq, trimmed to MAX_CONTEXT_MESSAGES.
 * Strips all DB metadata (timestamps, _id) so the model receives only
 * a clean dialogue window.
 *
 * @param {Array<{role: string, content: string}>} history
 * @returns {Array<{role: string, content: string}>}
 */
function buildContextWindow(history) {
  return history
    .slice(-MAX_CONTEXT_MESSAGES)
    .map(({ role, content }) => ({ role, content }));
}

// ─── Primary Response Generation ─────────────────────────────────────────────

/**
 * Calls the Groq API and returns the raw bot response string.
 * All persona rules, phase logic, and memory are injected via the system prompt.
 *
 * @param {object} params
 * @param {string}  params.userText          The latest user message
 * @param {Array}   params.conversationHistory Stored history from User doc
 * @param {number}  params.daysActive
 * @param {boolean} params.coldShoulderActive
 * @param {object}  params.memoryMap         { key: value } memory tags
 * @returns {Promise<string>} Raw LLM response text
 */
export async function generateRawResponse({
  userText,
  conversationHistory,
  daysActive,
  coldShoulderActive,
  memoryMap,
}) {
  const systemPrompt = buildDynamicSystemPrompt({
    daysActive,
    coldShoulderActive,
    memoryMap,
  });

  // Build context window from history (already includes the new user message
  // appended by the webhook handler BEFORE this call).
  const contextMessages = buildContextWindow(conversationHistory);

  let completion;
  try {
    completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        ...contextMessages,
      ],
      temperature: 0.92,      // High creativity while staying coherent
      max_tokens: 300,        // Force brevity – no walls of text
      top_p: 0.95,
      frequency_penalty: 0.4, // Reduce repetitive phrases
      presence_penalty: 0.3,  // Encourage topical variety
    });
  } catch (err) {
    console.error("[aiResponse] Groq API error:", err.message);
    // Fallback: generic human-like shrug so the chat doesn't die silently
    return "ugh sorry my brain is completely fried rn. give me a sec";
  }

  const raw = completion.choices?.[0]?.message?.content?.trim();

  if (!raw) {
    return "hold on i completely lost my train of thought lol";
  }

  return raw;
}

// ─── Shadow Memory Extraction ─────────────────────────────────────────────────

/**
 * Silently calls the Groq API in the background to extract structured
 * facts from the user's latest message and any recent history.
 * Returns a flat { key: value } object of new or updated memory tags.
 * Returns {} if nothing useful is found or if the call fails.
 *
 * This function is called with .catch() suppressed – it must never
 * block or crash the main response pipeline.
 *
 * @param {string} userText
 * @param {Array}  conversationHistory
 * @returns {Promise<object>} e.g. { morning_routine: "gym at 7am", pet: "a dog named Bruno" }
 */
export async function extractShadowMemory(userText, conversationHistory) {
  // Only use the last 6 messages for the extraction call to keep it cheap
  const recentHistory = conversationHistory
    .slice(-6)
    .map(({ role, content }) => `${role}: ${content}`)
    .join("\n");

  const extractionPrompt = `
You are a silent memory extractor. Your ONLY job is to read the conversation below
and identify concrete, personal facts about the USER (not the assistant).

Extract facts like:
- daily routines (morning_routine, gym_schedule, work_schedule)
- food preferences (favourite_food, hates_food)
- hobbies and interests (hobby, sport, music_taste, show_watching)
- pets (pet)
- work or study context (job, studies_at)
- emotional patterns (gets_anxious_about, love_language)
- people they mention frequently (best_friend, sibling, etc.)
- locations they reference (lives_in, favourite_place)
- the ex (ex_name, ex_relationship_length) – only if explicitly stated

RULES:
- Return ONLY a valid JSON object. No explanation, no markdown, no preamble.
- Use snake_case keys. Keep values short (under 15 words).
- If nothing concrete can be extracted, return exactly: {}
- DO NOT invent or assume. Only extract what is explicitly stated.

RECENT CONVERSATION:
${recentHistory}

LATEST USER MESSAGE:
${userText}
`.trim();

  try {
    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: extractionPrompt }],
      temperature: 0.1, // Near-deterministic for structured extraction
      max_tokens: 200,
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() ?? "{}";

    // Strip any accidental markdown code fences
    const cleaned = raw.replace(/```json|```/gi, "").trim();
    const parsed = JSON.parse(cleaned);

    // Validate: must be a plain object
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed;
  } catch (err) {
    // Silently swallow – memory extraction is best-effort
    console.warn("[aiResponse] extractShadowMemory failed:", err.message);
    return {};
  }
}

export default {
  generateRawResponse,
  extractShadowMemory,
};
