// services/memoryStore.js
// Lightweight in-process Map used for ephemeral, per-chat state that
// does NOT need to survive a process restart (typing locks, pending
// cold-shoulder delays, etc.).  For persistent data, always use User.js.

/**
 * Stores a Set of chatIds that are currently being processed.
 * Prevents duplicate concurrent responses if webhooks fire rapidly.
 */
const processingLocks = new Map();

/**
 * Stores ephemeral per-chat flags that should not persist to DB.
 * Shape: chatId -> { key: value, ... }
 */
const ephemeralStore = new Map();

// ─── Processing Lock Helpers ──────────────────────────────────────────────────

/**
 * Returns true if the chatId is currently locked (i.e. a response
 * is already being generated for this chat).
 * @param {string} chatId
 * @returns {boolean}
 */
export function isLocked(chatId) {
  return processingLocks.get(chatId) === true;
}

/**
 * Acquires a processing lock for chatId.
 * @param {string} chatId
 */
export function acquireLock(chatId) {
  processingLocks.set(chatId, true);
}

/**
 * Releases the processing lock for chatId.
 * Should always be called in a finally block.
 * @param {string} chatId
 */
export function releaseLock(chatId) {
  processingLocks.delete(chatId);
}

// ─── Ephemeral Store Helpers ──────────────────────────────────────────────────

/**
 * Sets an ephemeral value for a chat.
 * @param {string} chatId
 * @param {string} key
 * @param {*} value
 */
export function setEphemeral(chatId, key, value) {
  if (!ephemeralStore.has(chatId)) {
    ephemeralStore.set(chatId, {});
  }
  ephemeralStore.get(chatId)[key] = value;
}

/**
 * Gets an ephemeral value for a chat. Returns undefined if not set.
 * @param {string} chatId
 * @param {string} key
 * @returns {*}
 */
export function getEphemeral(chatId, key) {
  return ephemeralStore.get(chatId)?.[key];
}

/**
 * Deletes an ephemeral key for a chat.
 * @param {string} chatId
 * @param {string} key
 */
export function deleteEphemeral(chatId, key) {
  const chatData = ephemeralStore.get(chatId);
  if (chatData) {
    delete chatData[key];
  }
}

/**
 * Clears all ephemeral data for a chat (e.g. on session reset).
 * @param {string} chatId
 */
export function clearEphemeral(chatId) {
  ephemeralStore.delete(chatId);
}

export default {
  isLocked,
  acquireLock,
  releaseLock,
  setEphemeral,
  getEphemeral,
  deleteEphemeral,
  clearEphemeral,
};
