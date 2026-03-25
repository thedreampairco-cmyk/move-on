// server.js
// Application entry point.
// Responsibilities:
//   1. Connect to MongoDB
//   2. Mount Express middleware & routes
//   3. Register cron jobs
//   4. Start listening

import express from "express";
import mongoose from "mongoose";
import { MONGO_URI, PORT } from "./config/env.js";
import webhookRouter from "./routes/webhook.js";
import { registerCronJobs } from "./cronJobs.js";

// ─── App Setup ────────────────────────────────────────────────────────────────

const app = express();

// Parse JSON bodies (Green API sends application/json)
app.use(express.json());

// Minimal request logging
app.use((req, _res, next) => {
  if (req.path !== "/health") {
    console.log(`[http] ${req.method} ${req.path}`);
  }
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /webhook
 * Receives Green API event notifications.
 */
app.use("/webhook", webhookRouter);

/**
 * GET /health
 * Simple liveness probe for uptime monitors / hosting platforms.
 */
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

// 404 handler for unmatched routes
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error("[server] Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ─── DB Connection + Boot Sequence ───────────────────────────────────────────

async function startServer() {
  try {
    console.log("[server] Connecting to MongoDB...");
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 8000,
    });
    console.log("[server] MongoDB connected.");

    // Register scheduled proactive jobs after DB is confirmed live
    registerCronJobs();

    app.listen(PORT, () => {
      console.log(`
╔══════════════════════════════════════════════╗
║         Move-On Bot – Server Online           ║
╠══════════════════════════════════════════════╣
║  Port    : ${String(PORT).padEnd(34)}║
║  Webhook : POST /webhook${" ".repeat(20)}║
║  Health  : GET  /health${" ".repeat(21)}║
╚══════════════════════════════════════════════╝
      `.trim());
    });
  } catch (err) {
    console.error("[server] FATAL: Failed to start:", err.message);
    process.exit(1);
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`\n[server] Received ${signal}. Shutting down gracefully...`);
  try {
    await mongoose.connection.close();
    console.log("[server] MongoDB connection closed.");
  } catch (err) {
    console.error("[server] Error closing MongoDB:", err.message);
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Unhandled Rejection Guard ────────────────────────────────────────────────

process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled Promise Rejection:", reason);
  // Don't exit – log and continue; individual handlers catch their own errors
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

startServer();
