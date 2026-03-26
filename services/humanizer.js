// services/humanizer.js
// Humanization layer: typo injection, double-texting, and casing variants.
// Actual delay + send is delegated entirely to typingDelay.delayAndSend
// which implements the Golden Rule timing sequence.

import { sendTextMessage, setChatState, sleep } from "./greenApi.js";
import { delayAndSend } from "./typingDelay.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPO_CHANCE              = 0.05;  // 5% chance per fragment
const TYPO_CORRECTION_DELAY_MS = 2_000;
const FRAGMENT_MIN_LENGTH      = 80;    // chars before we consider splitting
const CASUAL_FILLERS           = ["haha", "arey yaar", "tbh", "ngl", "idk"];
const THINKING_OPENERS         = ["okay so", "wait", "ok but", "i mean", "ngl", "honestly"];

// ─── Utilities ────────────────────────────────────────────────────────────────

function chance(p)       { return Math.random() < p; }
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function scrambleWord(word) {
  if (word.length <= 3) return word;
  const chars = word.slice(1, -1).split("");
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return word[0] + chars.join("") + word[word.length - 1];
}

// ─── 1. Typo + Correction ─────────────────────────────────────────────────────

/**
 * 5% chance to scramble one word in the text.
 * Returns { hasTypo: false, text } or { hasTypo: true, typoText, correctionText }.
 */
export function applyTypoAndCorrect(botText) {
  if (!chance(TYPO_CHANCE)) return { hasTypo: false, text: botText };

  const words      = botText.split(" ");
  const candidates = words.map((w, i) => ({ w, i })).filter(({ w }) => /^[a-zA-Z]{4,}$/.test(w));
  if (candidates.length === 0) return { hasTypo: false, text: botText };

  const { w: original, i: idx } = pickRandom(candidates);
  const typoWord = scrambleWord(original);
  if (typoWord === original) return { hasTypo: false, text: botText };

  const typoWords     = [...words];
  typoWords[idx]      = typoWord;
  return {
    hasTypo:         true,
    typoText:        typoWords.join(" "),
    correctionText:  `*${original}`,
  };
}

// ─── 2. Text Fragmentation ────────────────────────────────────────────────────

function splitIntoFragments(text) {
  if (text.length < FRAGMENT_MIN_LENGTH) return [text];

  const midStart = Math.floor(text.length * 0.35);
  const midEnd   = Math.floor(text.length * 0.70);

  for (const regex of [/[.!?]\s+/g, /,\s+/g]) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      const idx = match.index + match[0].length;
      if (idx >= midStart && idx <= midEnd) {
        const p1 = text.slice(0, idx).trim();
        const p2 = text.slice(idx).trim();
        if (p1 && p2) return [p1, p2];
      }
    }
  }

  // Hard split at midpoint space
  const mid   = Math.floor(text.length / 2);
  const space = text.indexOf(" ", mid);
  const split = space !== -1 ? space + 1 : mid;
  const p1    = text.slice(0, split).trim();
  const p2    = text.slice(split).trim();
  return (p1 && p2) ? [p1, p2] : [text];
}

// ─── 3. Human Style Variants ──────────────────────────────────────────────────

export function addHumanVariants(text) {
  let result = text.charAt(0).toLowerCase() + text.slice(1);

  if (chance(0.15)) {
    const opener = pickRandom(THINKING_OPENERS);
    result = `${opener} ${result}`;
  }
  if (chance(0.10)) {
    const filler   = pickRandom(CASUAL_FILLERS);
    const lastWord = result.split(" ").pop()?.toLowerCase() ?? "";
    if (!CASUAL_FILLERS.includes(lastWord)) {
      result = result.replace(/[.!?]+$/, "") + ` ${filler}`;
    }
  }
  return result;
}

// ─── 4. Master Send Orchestrator ─────────────────────────────────────────────

/**
 * Full pipeline:
 *   rawText → addHumanVariants → split fragments
 *   → per fragment: applyTypoAndCorrect → delayAndSend (Golden Rule timing)
 *
 * @param {string}  chatId
 * @param {string}  rawText      Raw LLM output
 * @param {object}  user         Mongoose User document (for timing + score)
 * @param {number}  initialDelayMs  Pre-computed initial delay (-1 = auto-compute)
 */
export async function humanizeAndSend(chatId, rawText, user, initialDelayMs = -1) {
  const humanized = addHumanVariants(rawText);
  const fragments = splitIntoFragments(humanized);

  for (let i = 0; i < fragments.length; i++) {
    const fragment   = fragments[i];
    const typoResult = applyTypoAndCorrect(fragment);

    if (typoResult.hasTypo) {
      // Send the typo version through full Golden Rule delay
      await delayAndSend({
        chatId,
        text:            typoResult.typoText,
        user,
        isFirstFragment: i === 0,
        initialDelayMs:  i === 0 ? initialDelayMs : -1,
      });

      // Brief human pause before the correction
      await sleep(TYPO_CORRECTION_DELAY_MS);
      await setChatState(chatId, "composing");
      await sleep(600);
      await sendTextMessage(chatId, typoResult.correctionText);
    } else {
      await delayAndSend({
        chatId,
        text:            typoResult.text,
        user,
        isFirstFragment: i === 0,
        initialDelayMs:  i === 0 ? initialDelayMs : -1,
      });
    }
  }
}

export default { applyTypoAndCorrect, addHumanVariants, humanizeAndSend };
