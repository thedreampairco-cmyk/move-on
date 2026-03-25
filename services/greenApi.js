// services/greenApi.js
// Thin wrapper around Green API's REST endpoints.
// Handles: sending text messages, setting chat state (typing/recording),
// and reading incoming webhook payloads.

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
 * Green API expects: /waInstance{id}/{method}/{token}
 * @param {string} method  e.g. "sendMessage", "showTyping"
 * @returns {string}
 */
function endpoint(method) {
  return `/${method}/${GREEN_API_TOKEN}`;
}

/**
 * Waits for `ms` milliseconds.  Used to simulate natural typing cadence.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Chat State ───────────────────────────────────────────────────────────────

/**
 * Sets the WhatsApp chat state for a given chatId.
 * Called immediately when a webhook arrives to simulate a human reading
 * the message before typing a reply.
 *
 * @param {string} chatId  e.g. "919XXXXXXXXX@c.us"
 * @param {"composing"|"recording"|"paused"} state
 * @returns {Promise<void>}
 */
export async function setChatState(chatId, state = "composing") {
  try {
    await greenClient.post(endpoint("showTyping"), {
      chatId,
      typeOfActivity: state, // Green API param name
    });
  } catch (err) {
    // Non-fatal – typing indicator failure should never block the response.
    console.warn(
      `[greenApi] setChatState failed for ${chatId} (${state}):`,
      err.response?.data ?? err.message
    );
  }
}

// ─── Messaging ────────────────────────────────────────────────────────────────

/**
 * Sends a plain-text WhatsApp message to a chatId.
 *
 * @param {string} chatId
 * @param {string} text
 * @returns {Promise<string|null>} Green API idMessage on success, null on error
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
 * Sends a text message with a realistic typing delay before it.
 * The delay is proportional to message length (≈ 40 ms per character),
 * clamped between 1 000 ms and 5 000 ms.
 *
 * @param {string} chatId
 * @param {string} text
 * @returns {Promise<string|null>}
 */
export async function sendWithTypingDelay(chatId, text) {
  const delay = Math.min(5000, Math.max(1000, text.length * 40));
  await setChatState(chatId, "composing");
  await sleep(delay);
  return sendTextMessage(chatId, text);
}

// ─── Webhook Parsing ──────────────────────────────────────────────────────────

/**
 * Parses the raw JSON body from a Green API webhook notification.
 * Returns a normalized object or null if the payload is not an inbound
 * text message we care about.
 *
 * Supported typeWebhook: "incomingMessageReceived"
 * Supported messageData.typeMessage: "textMessage"
 *
 * @param {object} body  Raw express req.body
 * @returns {{ chatId: string, senderName: string, text: string } | null}
 */
export function parseIncomingWebhook(body) {
  if (!body || body.typeWebhook !== "incomingMessageReceived") {
    return null;
  }

  const msgData = body.messageData;
  if (!msgData || msgData.typeMessage !== "textMessage") {
    // We only handle plain text for now.  Ignore images, stickers, etc.
    return null;
  }

  const chatId = body.senderData?.chatId;
  const senderName = body.senderData?.senderName ?? "User";
  const text = msgData.textMessageData?.textMessage?.trim();

  if (!chatId || !text) {
    return null;
  }

  return { chatId, senderName, text };
}

export default {
  setChatState,
  sendTextMessage,
  sendWithTypingDelay,
  parseIncomingWebhook,
  sleep,
};
