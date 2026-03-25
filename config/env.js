// config/env.js
// Centralized environment variable loader and validator.
// All other modules import from here, never directly from process.env.

import dotenv from "dotenv";
dotenv.config();

function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `[config/env.js] FATAL: Missing required environment variable: ${key}\n` +
        `Make sure you have a .env file at the project root with all required variables.`
    );
  }
  return value;
}

function optionalEnv(key, defaultValue = "") {
  return process.env[key] ?? defaultValue;
}

// ─── Required ──────────────────────────────────────────────────────────────────
export const GROQ_API_KEY = requireEnv("GROQ_API_KEY");
export const MONGO_URI = requireEnv("MONGO_URI");

// Green API credentials – obtained from https://green-api.com
export const GREEN_API_INSTANCE_ID = requireEnv("GREEN_API_INSTANCE_ID");
export const GREEN_API_TOKEN = requireEnv("GREEN_API_TOKEN");

// ─── Optional / defaults ───────────────────────────────────────────────────────
export const PORT = optionalEnv("PORT", "3000");

// Base URL for Green API calls (versioned endpoint)
export const GREEN_API_BASE_URL = optionalEnv(
  "GREEN_API_BASE_URL",
  `https://api.green-api.com/waInstance${process.env.GREEN_API_INSTANCE_ID}`
);

// Groq model to use for chat completions
export const GROQ_MODEL = optionalEnv("GROQ_MODEL", "llama-3.3-70b-versatile");

// Bot's display name – used in system prompt self-references
export const BOT_NAME = optionalEnv("BOT_NAME", "Alex");

// Timezone used for time-of-day logic (IANA format)
export const TIMEZONE = optionalEnv("TIMEZONE", "Asia/Kolkata");

// Maximum conversation history messages sent to LLM
export const MAX_CONTEXT_MESSAGES = parseInt(
  optionalEnv("MAX_CONTEXT_MESSAGES", "15"),
  10
);

// How many hours of silence before "Cold Shoulder" friction kicks in
export const COLD_SHOULDER_HOURS = parseInt(
  optionalEnv("COLD_SHOULDER_HOURS", "18"),
  10
);

// Cron timezone for scheduled jobs
export const CRON_TIMEZONE = optionalEnv("CRON_TIMEZONE", "Asia/Kolkata");

export default {
  GROQ_API_KEY,
  MONGO_URI,
  GREEN_API_INSTANCE_ID,
  GREEN_API_TOKEN,
  GREEN_API_BASE_URL,
  PORT,
  GROQ_MODEL,
  BOT_NAME,
  TIMEZONE,
  MAX_CONTEXT_MESSAGES,
  COLD_SHOULDER_HOURS,
  CRON_TIMEZONE,
};
