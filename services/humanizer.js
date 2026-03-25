// services/humanizer.js
// Transforms clean LLM output into believably human WhatsApp messages.
//
// Behaviours implemented:
//   1. applyTypoAndCorrect  – 5% chance to scramble one word, send typo,
//                             wait 2 s, then send *corrected version.
//   2. fragmentAndSendText  – splits long output on punctuation and sends
//                             as natural "double texts" with a pause between.
//   3. addHumanVariants     – randomly applies lowercase drift, stutter
//                             openings, and trailing "lol"/"haha" fillers.

import { sendTextMessage, sendWithTypingDelay, setChatState, sleep } from "./greenApi.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPO_CHANCE = 0.05; // 5%
const TYPO_CORRECTION_DELAY_MS = 2000;

// Minimum character length before we consider fragmenting
const FRAGMENT_MIN_LENGTH = 80;

// Filler words appended occasionally to feel casual
const CASUAL_FILLERS = ["lol", "haha", "tbh", "ngl", "idk", "ugh"];

// Stutter-style openers that feel like thinking-out-loud
const THINKING_OPENERS = [
  "okay so",
  "wait",
  "ok but",
  "i mean",
  "ngl",
  "honestly",
  "ok so",
];

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Returns true with the given probability (0–1).
 * @param {number} probability
 * @returns {boolean}
 */
function chance(probability) {
  return Math.random() < probability;
}

/**
 * Shuffles a word's letters to create a realistic typo.
 * Keeps first and last characters in place (humans rarely typo those).
 * @param {string} word
 * @returns {string}
 */
function scrambleWord(word) {
  if (word.length <= 3) return word; // Too short to scramble meaningfully
  const chars = word.slice(1, -1).split("");
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return word[0] + chars.join("") + word[word.length - 1];
}

/**
 * Picks a random element from an array.
 * @param {Array} arr
 * @returns {*}
 */
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── 1. Typo + Correction ─────────────────────────────────────────────────────

/**
 * Applies a 5% chance typo injection to the bot's response.
 *
 * Behaviour:
 *   - Selects a random "typeable" word (length ≥ 4, no punctuation-only tokens).
 *   - Returns { hasTypo: false, text } if no typo fires.
 *   - Returns { hasTypo: true, typoText, correctionText } if typo fires.
 *     Caller is responsible for sending both with a delay between them.
 *
 * @param {string} botText
 * @returns {{ hasTypo: boolean, text?: string, typoText?: string, correctionText?: string }}
 */
export function applyTypoAndCorrect(botText) {
  if (!chance(TYPO_CHANCE)) {
    return { hasTypo: false, text: botText };
  }

  const words = botText.split(" ");
  // Find candidate indices: words with 4+ actual letters
  const candidates = words
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => /^[a-zA-Z]{4,}$/.test(w));

  if (candidates.length === 0) {
    return { hasTypo: false, text: botText };
  }

  const { w: originalWord, i: wordIndex } = pickRandom(candidates);
  const typoWord = scrambleWord(originalWord);

  if (typoWord === originalWord) {
    // Scramble produced the same word – skip typo
    return { hasTypo: false, text: botText };
  }

  const typoWords = [...words];
  typoWords[wordIndex] = typoWord;
  const typoText = typoWords.join(" ");
  const correctionText = `*${originalWord}`;

  return { hasTypo: true, typoText, correctionText };
}

// ─── 2. Fragment & Double-Text ────────────────────────────────────────────────

/**
 * Splits `botText` into 1–2 natural fragments and sends them as a "double text"
 * with a realistic typing delay between them.
 *
 * Split logic:
 *   - If text is short (< FRAGMENT_MIN_LENGTH chars), send as one message.
 *   - Otherwise, find the best split point: sentence boundary or the midpoint
 *     of the string after a comma/period.
 *
 * After splitting, each fragment passes through `applyTypoAndCorrect`
 * independently and any typo corrections are sent inline.
 *
 * @param {string} chatId
 * @param {string} botText
 * @returns {Promise<void>}
 */
export async function fragmentAndSendText(chatId, botText) {
  const fragments = splitIntoFragments(botText);

  for (let i = 0; i < fragments.length; i++) {
    const fragment = fragments[i];

    // Apply typo logic per fragment
    const typoResult = applyTypoAndCorrect(fragment);

    if (typoResult.hasTypo) {
      // Send the typo version first
      await sendWithTypingDelay(chatId, typoResult.typoText);
      // Brief pause as if the person re-reads what they sent
      await sleep(TYPO_CORRECTION_DELAY_MS);
      // Send the asterisk correction
      await setChatState(chatId, "composing");
      await sleep(600);
      await sendTextMessage(chatId, typoResult.correctionText);
    } else {
      await sendWithTypingDelay(chatId, typoResult.text);
    }

    // Inter-fragment delay to simulate the natural pause before a double text
    if (i < fragments.length - 1) {
      const interDelay = 1500 + Math.random() * 2000; // 1.5 – 3.5 s
      await sleep(interDelay);
    }
  }
}

/**
 * Splits text into at most 2 natural fragments.
 * @param {string} text
 * @returns {string[]}
 */
function splitIntoFragments(text) {
  if (text.length < FRAGMENT_MIN_LENGTH) {
    return [text];
  }

  // Try to split on a sentence-ending punctuation followed by a space
  // Prefer a split roughly in the middle third of the string
  const midStart = Math.floor(text.length * 0.35);
  const midEnd = Math.floor(text.length * 0.70);

  // Look for ". ", "! ", "? " in the middle zone
  const sentenceBreakRegex = /[.!?]\s+/g;
  let bestSplit = -1;
  let match;
  while ((match = sentenceBreakRegex.exec(text)) !== null) {
    const idx = match.index + match[0].length;
    if (idx >= midStart && idx <= midEnd) {
      bestSplit = idx;
      break;
    }
  }

  // Fallback: split on ", " in the middle zone
  if (bestSplit === -1) {
    const commaRegex = /,\s+/g;
    while ((match = commaRegex.exec(text)) !== null) {
      const idx = match.index + match[0].length;
      if (idx >= midStart && idx <= midEnd) {
        bestSplit = idx;
        break;
      }
    }
  }

  // Last fallback: hard split at midpoint on a space boundary
  if (bestSplit === -1) {
    const mid = Math.floor(text.length / 2);
    const spaceAfter = text.indexOf(" ", mid);
    bestSplit = spaceAfter !== -1 ? spaceAfter + 1 : mid;
  }

  const part1 = text.slice(0, bestSplit).trim();
  const part2 = text.slice(bestSplit).trim();

  if (!part1 || !part2) return [text];
  return [part1, part2];
}

// ─── 3. Human Style Variants ──────────────────────────────────────────────────

/**
 * Optionally adds subtle human markers to the generated text:
 *   - 15% chance: prepend a thinking opener ("okay so", "wait", etc.)
 *   - 10% chance: append a casual filler ("lol", "ngl", etc.)
 *   - Ensures the text is lowercased (paranoia check if LLM drifts)
 *
 * @param {string} text
 * @returns {string}
 */
export function addHumanVariants(text) {
  let result = text;

  // Paranoia lowercase enforcement
  result = result.charAt(0).toLowerCase() + result.slice(1);

  // Occasionally prepend a thinking opener
  if (chance(0.15)) {
    const opener = pickRandom(THINKING_OPENERS);
    result = `${opener} ${result}`;
  }

  // Occasionally append a casual filler
  if (chance(0.10)) {
    const filler = pickRandom(CASUAL_FILLERS);
    // Don't double up if the text already ends with a filler
    const lastWord = result.split(" ").pop()?.toLowerCase() ?? "";
    if (!CASUAL_FILLERS.includes(lastWord)) {
      // Remove trailing punctuation before appending
      result = result.replace(/[.!?]+$/, "") + ` ${filler}`;
    }
  }

  return result;
}

// ─── Master Send Orchestrator ─────────────────────────────────────────────────

/**
 * The single entry point used by the webhook handler.
 * Applies all humanization layers then dispatches the message(s).
 *
 * Pipeline:
 *   rawLLMText → addHumanVariants → fragmentAndSendText (which internally
 *   calls applyTypoAndCorrect per fragment)
 *
 * @param {string} chatId
 * @param {string} rawText   Raw output from generateRawResponse
 * @returns {Promise<void>}
 */
export async function humanizeAndSend(chatId, rawText) {
  const humanized = addHumanVariants(rawText);
  await fragmentAndSendText(chatId, humanized);
}

export default {
  applyTypoAndCorrect,
  fragmentAndSendText,
  addHumanVariants,
  humanizeAndSend,
};
