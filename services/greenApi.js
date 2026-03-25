import axios from "axios";
import {
  GREEN_API_BASE_URL,
  GREEN_API_TOKEN,
} from "../config/env.js";

// ─── Axios instance ───────────────────────────────────────────────────────────

const greenClient = axios.create({
  baseURL: GREEN_API_BASE_URL,
  timeout: 15000,
  headers: { "Content-Type": "application/json" },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds the authenticated URL path for a given Green API method.
 * @param {string} method  e.g. "sendMessage", "showTyping"
 * @returns {string}
 */
function endpoint(method) {
  return `/${method}/${GREEN_API_TOKEN}`;
}

/**
 * Waits for `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Chat State ───────────────────────────────────────────────────────────────

/**
 * Sets the WhatsApp chat state for a given chatId.
 * Includes fallback logic for different Green API versions and plan restrictions.
 */
export async function setChatState(chatId, state = "composing") {
  try {
    // Try standard 'showTyping' first (most common for current Green API)
    await greenClient.post(endpoint("showTyping"), {
      chatId,
      typeOfActivity: state,
    });
  } catch (err) {
    const status = err.response?.status;
    if (status === 403) return; // Plan restriction - silent skip

    // Fallback: Try legacy 'sendTyping' or 'sendChatAction' if showTyping 404s
    try {
      await greenClient.post(endpoint("sendTyping"), {
        chatId,
        typeOfActivity: state === "composing" ? "typing" : state,
      });
    } catch {
      // Both failed - non-fatal
    }
  }
}

// ─── Messaging ────────────────────────────────────────────────────────────────

/**
 * Sends a plain-text WhatsApp message.
 */
export async function sendTextMessage(chatId, text) {
  try {
    const res = await greenClient.post(endpoint("sendMessage"), {
      chatId,
      message: text,
    });
    return res.data?.idMessage ?? null;
  } catch (err) {
    console.error(
      `[greenApi] sendTextMessage failed for ${chatId}:`,
      err.response?.data ?? err.message
    );
    return null;
  }
}

/**
 * Sends text with a realistic delay proportional to length.
 */
export async function sendWithTypingDelay(chatId, text) {
  const delay = Math.min(5000, Math.max(1000, text.length * 40));
  await setChatState(chatId, "composing");
  await sleep(delay);
  return sendTextMessage(chatId, text);
}

// ─── Webhook Parsing ──────────────────────────────────────────────────────────

/**
 * FIXED: Now handles both 'textMessage' and 'extendedTextMessage'.
 */
export function parseIncomingWebhook(body) {
  if (!body || body.typeWebhook !== "incomingMessageReceived") {
    return null;
  }

  const msgData = body.messageData;
  if (!msgData) return null;

  const type = msgData.typeMessage;
  let text = "";

  // Support for standard and extended (replies/links/formatted) messages
  if (type === "textMessage") {
    text = msgData.textMessageData?.textMessage;
  } else if (type === "extendedTextMessage") {
    text = msgData.extendedTextMessageData?.text;
  }

  const chatId = body.senderData?.chatId;
  const senderName = body.senderData?.senderName ?? "User";

  if (!chatId || !text) {
    return null;
  }

  return { chatId, senderName, text: text.trim() };
}

export default {
  setChatState,
  sendTextMessage,
  sendWithTypingDelay,
  parseIncomingWebhook,
  sleep,
};
