// test.js
// Run with: node test.js
// Tests:
//   1. Environment variables present
//   2. Groq API direct call
//   3. Green API instance state (authorized?)
//   4. Green API typing indicator
//   5. Green API send real WhatsApp message
//   6. Local server health check
//   7. Webhook endpoint simulation
//   8. Humanizer unit test (no network)

import dotenv from "dotenv";
dotenv.config();

import axios from "axios";

// ─── Config ───────────────────────────────────────────────────────────────────

const SERVER_URL = `http://localhost:${process.env.PORT || 3000}`;
const INSTANCE_ID = process.env.GREEN_API_INSTANCE_ID;
const TOKEN = process.env.GREEN_API_TOKEN;
const GREEN_BASE = `https://api.green-api.com/waInstance${INSTANCE_ID}`;

// ⚠️  Add TEST_CHAT_ID=919XXXXXXXXX@c.us to your .env to run live send tests
const TEST_CHAT_ID = process.env.TEST_CHAT_ID || null;

const C = {
  reset:  "\x1b[0m",
  green:  "\x1b[32m",
  red:    "\x1b[31m",
  yellow: "\x1b[33m",
  cyan:   "\x1b[36m",
  bold:   "\x1b[1m",
};

// ─── Logging Helpers ──────────────────────────────────────────────────────────

function pass(label, detail = "")  { console.log(`${C.green}${C.bold}✅  ${label}${C.reset}  ${detail}`); }
function fail(label, detail = "")  { console.log(`${C.red}${C.bold}❌  ${label}${C.reset}  ${detail}`); }
function info(label, detail = "")  { console.log(`${C.cyan}ℹ️   ${label}${C.reset}  ${detail}`); }
function warn(label, detail = "")  { console.log(`${C.yellow}⚠️   ${label}${C.reset}  ${detail}`); }
function section(title) {
  console.log(`\n${C.bold}${C.cyan}${"─".repeat(52)}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  ${title}${C.reset}`);
  console.log(`${C.bold}${C.cyan}${"─".repeat(52)}${C.reset}`);
}

// ─── TEST 1: Environment Variables ───────────────────────────────────────────

async function testEnvVars() {
  section("TEST 1: Environment Variables");

  const required = ["GROQ_API_KEY", "MONGO_URI", "GREEN_API_INSTANCE_ID", "GREEN_API_TOKEN"];
  let allOk = true;

  for (const key of required) {
    if (process.env[key]) {
      pass(key, `${process.env[key].slice(0, 10)}...`);
    } else {
      fail(key, "MISSING – add to .env");
      allOk = false;
    }
  }

  if (!TEST_CHAT_ID) {
    warn("TEST_CHAT_ID", "Not set – add TEST_CHAT_ID=919XXXXXXXXX@c.us to .env for live send tests");
  } else {
    pass("TEST_CHAT_ID", TEST_CHAT_ID);
  }

  return allOk;
}

// ─── TEST 2: Groq API ─────────────────────────────────────────────────────────

async function testGroqApi() {
  section("TEST 2: Groq API – Direct Completion");

  try {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: process.env.GROQ_MODEL || "llama3-70b-8192",
        messages: [
          { role: "system", content: "you are alex. reply in one short lowercase sentence." },
          { role: "user",   content: "hey" },
        ],
        max_tokens: 60,
        temperature: 0.9,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    const reply = res.data?.choices?.[0]?.message?.content?.trim();
    if (reply) {
      pass("Groq response", `"${reply}"`);
      return true;
    } else {
      fail("Groq response", `Empty: ${JSON.stringify(res.data)}`);
      return false;
    }
  } catch (err) {
    fail("Groq API", err.response?.data ? JSON.stringify(err.response.data) : err.message);
    return false;
  }
}

// ─── TEST 3: Green API – Instance State ──────────────────────────────────────

async function testGreenApiConnection() {
  section("TEST 3: Green API – Instance State");

  try {
    const url = `${GREEN_BASE}/getStateInstance/${TOKEN}`;
    info("GET", url.replace(TOKEN, "***TOKEN***"));

    const res = await axios.get(url, { timeout: 10000 });
    const state = res.data?.stateInstance;

    if (state === "authorized") {
      pass("Instance state", `"${state}" – WhatsApp connected ✓`);
      return true;
    } else {
      fail("Instance state", `"${state}" – Expected "authorized". Scan QR at green-api.com`);
      return false;
    }
  } catch (err) {
    fail("Green API", err.response?.data ? JSON.stringify(err.response.data) : err.message);
    return false;
  }
}

// ─── TEST 4: Green API – Typing Indicator ────────────────────────────────────

async function testChatState() {
  section("TEST 4: Green API – Typing Indicator (showTyping)");

  if (!TEST_CHAT_ID) {
    warn("Skipped", "Set TEST_CHAT_ID in .env");
    return null;
  }

  try {
    const url = `${GREEN_BASE}/showTyping/${TOKEN}`;
    const payload = { chatId: TEST_CHAT_ID, typeOfActivity: "composing" };
    info("POST", url.replace(TOKEN, "***TOKEN***"));
    info("Payload", JSON.stringify(payload));

    const res = await axios.post(url, payload, { timeout: 10000 });
    pass("showTyping", JSON.stringify(res.data));
    return true;
  } catch (err) {
    fail("showTyping", err.response?.data ? JSON.stringify(err.response.data) : err.message);
    return false;
  }
}

// ─── TEST 5: Green API – Send Real Message ────────────────────────────────────

async function testGreenApiSend() {
  section("TEST 5: Green API – Send Real WhatsApp Message");

  if (!TEST_CHAT_ID) {
    warn("Skipped", "Set TEST_CHAT_ID=919XXXXXXXXX@c.us in .env");
    return null;
  }

  try {
    const url = `${GREEN_BASE}/sendMessage/${TOKEN}`;
    const payload = {
      chatId: TEST_CHAT_ID,
      message: "🤖 move-on bot test – Green API send is working!",
    };
    info("POST", url.replace(TOKEN, "***TOKEN***"));

    const res = await axios.post(url, payload, { timeout: 15000 });
    if (res.data?.idMessage) {
      pass("Message sent", `idMessage: ${res.data.idMessage}`);
      return true;
    } else {
      fail("Message send", `Unexpected: ${JSON.stringify(res.data)}`);
      return false;
    }
  } catch (err) {
    fail("Message send", err.response?.data ? JSON.stringify(err.response.data) : err.message);
    return false;
  }
}

// ─── TEST 6: Local Server Health ─────────────────────────────────────────────

async function testServerHealth() {
  section("TEST 6: Local Server – Health Check");

  try {
    const res = await axios.get(`${SERVER_URL}/health`, { timeout: 5000 });
    if (res.data?.status === "ok") {
      pass("Health", `Mongo: ${res.data.mongo} | Uptime: ${res.data.uptime?.toFixed(1)}s`);
      return true;
    } else {
      fail("Health", JSON.stringify(res.data));
      return false;
    }
  } catch (err) {
    fail("Server unreachable", `Is "node server.js" running? – ${err.message}`);
    return false;
  }
}

// ─── TEST 7: Webhook Simulation ───────────────────────────────────────────────

async function testWebhookSimulation() {
  section("TEST 7: Webhook Simulation – POST /webhook");

  const fakeChatId = TEST_CHAT_ID || "919999999999@c.us";

  const payload = {
    typeWebhook: "incomingMessageReceived",
    instanceData: {
      idInstance: INSTANCE_ID,
      wid: `${INSTANCE_ID}@c.us`,
      typeInstance: "whatsapp",
    },
    timestamp: Math.floor(Date.now() / 1000),
    idMessage: `TEST_${Date.now()}`,
    senderData: {
      chatId: fakeChatId,
      chatName: "Test User",
      sender: fakeChatId,
      senderName: "Test User",
    },
    messageData: {
      typeMessage: "textMessage",
      textMessageData: {
        textMessage: "hey i keep thinking about my ex, i can't stop",
      },
    },
  };

  info("Simulating", `Inbound text from ${fakeChatId}`);
  info("Message", `"${payload.messageData.textMessageData.textMessage}"`);

  try {
    const res = await axios.post(`${SERVER_URL}/webhook`, payload, {
      timeout: 10000,
      headers: { "Content-Type": "application/json" },
    });

    if (res.status === 200) {
      pass("Webhook accepted", `${res.status} – ${JSON.stringify(res.data)}`);
      info("Next", "Check server.js terminal for pipeline logs (Groq → humanizer → send)");
      return true;
    } else {
      fail("Webhook", `Status ${res.status}`);
      return false;
    }
  } catch (err) {
    fail(
      "Webhook POST",
      err.response
        ? `${err.response.status}: ${JSON.stringify(err.response.data)}`
        : `Server unreachable – ${err.message}`
    );
    return false;
  }
}

// ─── TEST 8: Humanizer Unit Test ──────────────────────────────────────────────

async function testHumanizerLogic() {
  section("TEST 8: Humanizer – Unit Test (offline)");

  let mod;
  try {
    mod = await import("./services/humanizer.js");
  } catch (err) {
    warn("Import failed", `${err.message} – run from project root`);
    return null;
  }

  const { applyTypoAndCorrect, addHumanVariants } = mod;

  // Lowercase enforcement
  const variant = addHumanVariants("THIS SHOULD BE LOWERCASED today");
  if (variant[0] === variant[0].toLowerCase()) {
    pass("addHumanVariants", `Lowercase OK: "${variant}"`);
  } else {
    fail("addHumanVariants", `Not lowercased: "${variant}"`);
  }

  // Typo rate check (100 runs → expect ~1–15 typos)
  const sample = "honestly everything feels broken when i think about it";
  let typos = 0;
  for (let i = 0; i < 100; i++) {
    if (applyTypoAndCorrect(sample).hasTypo) typos++;
  }
  if (typos >= 1 && typos <= 20) {
    pass("applyTypoAndCorrect", `Typo rate: ${typos}% over 100 runs (target ~5%)`);
  } else {
    warn("applyTypoAndCorrect", `Typo rate: ${typos}% – outside expected band`);
  }

  return true;
}

// ─── Main Runner ──────────────────────────────────────────────────────────────

async function runAll() {
  console.log(`\n${C.bold}${C.cyan}`);
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║       Move-On Bot  –  Test Suite             ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(C.reset);

  const results = {
    "Environment vars":       await testEnvVars(),
    "Groq API":               await testGroqApi(),
    "Green API state":        await testGreenApiConnection(),
    "Typing indicator":       await testChatState(),
    "WhatsApp send":          await testGreenApiSend(),
    "Server health":          await testServerHealth(),
    "Webhook endpoint":       await testWebhookSimulation(),
    "Humanizer logic":        await testHumanizerLogic(),
  };

  section("FINAL SUMMARY");

  let passed = 0, failed = 0, skipped = 0;
  for (const [label, result] of Object.entries(results)) {
    if (result === true)  { pass(label);            passed++;  }
    else if (result === false) { fail(label);        failed++;  }
    else                  { warn(label, "skipped"); skipped++; }
  }

  console.log(
    `\n${C.bold}Total: ${C.green}${passed} passed${C.reset}  ` +
    `${C.red}${failed} failed${C.reset}  ` +
    `${C.yellow}${skipped} skipped${C.reset}\n`
  );

  if (failed > 0 || skipped > 0) {
    console.log(`${C.yellow}Quick fixes:${C.reset}`);
    console.log("  1. Start server first:  node server.js");
    console.log("  2. Copy .env.example → .env and fill all keys");
    console.log("  3. Add TEST_CHAT_ID=919XXXXXXXXX@c.us to .env");
    console.log("  4. Green API instance must show 'authorized' (scan QR at green-api.com)\n");
  }
}

runAll().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
