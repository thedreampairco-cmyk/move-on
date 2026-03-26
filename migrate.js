// migrate.js
// One-time migration: converts memoryTags from legacy array format
// [{key, value, extractedAt}]  →  Map { key: value }
//
// Run ONCE before restarting the server:
//   node migrate.js
//
// Safe to re-run – already-migrated documents are skipped.

import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import { MONGO_URI } from "./config/env.js";

const C = {
  reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m",
  yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m",
};
const log  = (m) => console.log(`${C.cyan}${m}${C.reset}`);
const ok   = (m) => console.log(`${C.green}✅  ${m}${C.reset}`);
const warn = (m) => console.log(`${C.yellow}⚠️   ${m}${C.reset}`);
const err  = (m) => console.log(`${C.red}❌  ${m}${C.reset}`);

async function migrate() {
  console.log(`\n${C.bold}${C.cyan}══════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}${C.cyan}  Move-On Bot – memoryTags Migration${C.reset}`);
  console.log(`${C.bold}${C.cyan}══════════════════════════════════════════${C.reset}\n`);

  await mongoose.connect(MONGO_URI);
  log("MongoDB connected.");

  const db = mongoose.connection.db;
  const collection = db.collection("users");

  // Find all documents where memoryTags is an array (legacy format)
  const legacyUsers = await collection.find({
    memoryTags: { $type: "array" },
  }).toArray();

  log(`Found ${legacyUsers.length} document(s) with legacy array memoryTags.\n`);

  if (legacyUsers.length === 0) {
    ok("Nothing to migrate. All documents already use Map format.");
    await mongoose.disconnect();
    return;
  }

  let migrated = 0;
  let skipped  = 0;
  let failed   = 0;

  for (const user of legacyUsers) {
    try {
      const oldTags = user.memoryTags; // [{key, value, extractedAt}, ...]

      // Convert array → plain object (MongoDB stores Maps as plain objects)
      const newTagsObject = {};
      if (Array.isArray(oldTags)) {
        for (const tag of oldTags) {
          if (tag?.key && tag?.value) {
            // Sanitize key: lowercase, alphanumeric + underscore only
            const cleanKey = String(tag.key)
              .toLowerCase()
              .replace(/[^a-z0-9_]/g, "_")
              .replace(/__+/g, "_")
              .slice(0, 64);
            newTagsObject[cleanKey] = String(tag.value).trim();
          }
        }
      }

      const tagCount = Object.keys(newTagsObject).length;

      if (tagCount === 0 && oldTags.length > 0) {
        warn(`${user.chatId} – array had ${oldTags.length} entries but none had valid key/value. Writing empty Map.`);
      }

      // Replace the entire memoryTags field with the new object format
      await collection.updateOne(
        { _id: user._id },
        { $set: { memoryTags: newTagsObject } }
      );

      ok(`${user.chatId} – migrated ${oldTags.length} tags → ${tagCount} entries`);
      if (tagCount > 0) {
        console.log(`     Tags: ${JSON.stringify(newTagsObject)}`);
      }
      migrated++;

    } catch (e) {
      err(`${user.chatId} – FAILED: ${e.message}`);
      failed++;
    }
  }

  // Also fix any documents where memoryTags is missing entirely
  const missingResult = await collection.updateMany(
    { memoryTags: { $exists: false } },
    { $set: { memoryTags: {} } }
  );
  if (missingResult.modifiedCount > 0) {
    ok(`Initialized memoryTags: {} on ${missingResult.modifiedCount} document(s) that had no field.`);
  }

  console.log(`\n${C.bold}Summary:${C.reset}`);
  console.log(`  ${C.green}Migrated : ${migrated}${C.reset}`);
  console.log(`  ${C.yellow}Skipped  : ${skipped}${C.reset}`);
  console.log(`  ${C.red}Failed   : ${failed}${C.reset}\n`);

  if (failed === 0) {
    ok("Migration complete. You can now restart the server safely.");
  } else {
    err(`${failed} document(s) failed. Check logs above and re-run.`);
  }

  await mongoose.disconnect();
  log("MongoDB disconnected.\n");
  process.exit(failed > 0 ? 1 : 0);
}

migrate().catch((e) => {
  console.error("Migration crashed:", e);
  process.exit(1);
});
