// ─────────────────────────────────────────────
//  GEM Checker — Production Server
//  Supports: Gemini, PageGrid, OpenAI, Claude
//  Storage: MongoDB Atlas
//
//  Local:  node server.js
//  Render: node server.js
// ─────────────────────────────────────────────

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");
const url   = require("url");

const PORT         = process.env.PORT || 3000;
const MONGO_URI    = process.env.MONGO_URI || "";
const GEMINI_MODEL = "gemini-2.0-flash";

const MIME = {
  ".html": "text/html",
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".json": "application/json",
};

// ── Rate limiter ─────────────────────────────
const lastCallTime = {};
const MIN_INTERVAL = 5000;
const sleep        = ms => new Promise(r => setTimeout(r, ms));

async function rateLimit(keyId) {
  const now = Date.now(), last = lastCallTime[keyId] || 0;
  const wait = MIN_INTERVAL - (now - last);
  if (wait > 0) {
    console.log(`  Rate limit: waiting ${(wait/1000).toFixed(1)}s...`);
    await sleep(wait);
  }
  lastCallTime[keyId] = Date.now();
}

// ── HTTPS post helper ─────────────────────────
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const postData = Buffer.from(JSON.stringify(body));
    const req = https.request(
      { hostname, port: 443, path, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": postData.length, ...headers }
      },
      res => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: { raw: data } }); }
        });
      }
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// ══════════════════════════════════════════════
//  MONGODB PROFILE STORAGE
// ══════════════════════════════════════════════

// Simple MongoDB driver using HTTPS REST API (no npm needed!)
// Uses MongoDB Data API
let mongoClient = null;
let profilesCollection = null;

// Fallback: local JSON file if no MongoDB
const LOCAL_DB = path.join(__dirname, "profiles.json");

async function getProfile(uid) {
  if (MONGO_URI) {
    // Use MongoDB native driver via dynamic require
    try {
      if (!mongoClient) {
        const { MongoClient } = require("mongodb");
        mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        profilesCollection = mongoClient.db("gemchecker").collection("profiles");
        console.log("✓ MongoDB connected!");
      }
      const doc = await profilesCollection.findOne({ uid });
      return doc ? doc.profile : null;
    } catch(e) {
      console.error("MongoDB error:", e.message);
      return getProfileLocal(uid);
    }
  }
  return getProfileLocal(uid);
}

async function saveProfile(uid, profile) {
  if (MONGO_URI) {
    try {
      if (!mongoClient) {
        const { MongoClient } = require("mongodb");
        mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        profilesCollection = mongoClient.db("gemchecker").collection("profiles");
      }
      await profilesCollection.updateOne(
        { uid },
        { $set: { uid, profile, updatedAt: new Date() } },
        { upsert: true }
      );
      console.log(`  ✓ Profile saved to MongoDB for uid: ${uid.slice(0,8)}...`);
      return;
    } catch(e) {
      console.error("MongoDB save error:", e.message);
    }
  }
  saveProfileLocal(uid, profile);
}

function getProfileLocal(uid) {
  try {
    const db = fs.existsSync(LOCAL_DB) ? JSON.parse(fs.readFileSync(LOCAL_DB, "utf8")) : {};
    return db[uid]?.profile || null;
  } catch(e) { return null; }
}

function saveProfileLocal(uid, profile) {
  try {
    const db = fs.existsSync(LOCAL_DB) ? JSON.parse(fs.readFileSync(LOCAL_DB, "utf8")) : {};
    db[uid] = { profile, updatedAt: new Date().toISOString() };
    fs.writeFileSync(LOCAL_DB, JSON.stringify(db, null, 2));
    console.log(`  ✓ Profile saved to local file for uid: ${uid.slice(0,8)}...`);
  } catch(e) { console.error("Local save error:", e.message); }
}

// ══════════════════════════════════════════════
//  AI PROVIDERS
// ══════════════════════════════════════════════

async function callGemini(apiKey, pdfBase64, prompt) {
  const result = await httpsPost(
    "generativelanguage.googleapis.com",
    `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {},
    {
      contents: [{ parts: [{ inline_data: { mime_type: "application/pdf", data: pdfBase64 } }, { text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
    }
  );
  if (result.status !== 200) {
    const msg = result.body?.error?.message || "Gemini error";
    if (result.status === 429) throw new Error("Gemini quota exceeded. Please wait a few minutes.");
    if (result.status === 403) throw new Error("Invalid Gemini API key.");
    throw new Error(msg);
  }
  return result.body?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callPageGrid(apiKey, pdfBase64, prompt) {
  const result = await httpsPost(
    "api.pagegrid.in",
    "/v1/messages",
    { "api-key": apiKey },
    {
      model: "claude-opus-4-6",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }]
    }
  );
  if (result.status !== 200) {
    const msg = result.body?.error?.message || result.body?.message || "PageGrid error";
    if (result.status === 401) throw new Error("Invalid PageGrid API key.");
    if (result.status === 429) throw new Error("PageGrid rate limit. Please wait.");
    throw new Error(msg);
  }
  return result.body?.content?.map(c => c.text || "").join("") || "";
}

async function callOpenAI(apiKey, pdfBase64, prompt) {
  const result = await httpsPost(
    "api.openai.com",
    "/v1/chat/completions",
    { "Authorization": `Bearer ${apiKey}` },
    {
      model: "gpt-4o",
      max_tokens: 2048,
      messages: [
        { role: "system", content: "You are a GEM procurement expert. Return only valid JSON." },
        { role: "user",   content: `PDF base64: data:application/pdf;base64,${pdfBase64}\n\n${prompt}` }
      ]
    }
  );
  if (result.status !== 200) {
    if (result.status === 401) throw new Error("Invalid OpenAI API key.");
    if (result.status === 429) throw new Error("OpenAI rate limit. Please wait.");
    throw new Error(result.body?.error?.message || "OpenAI error");
  }
  return result.body?.choices?.[0]?.message?.content || "";
}

async function callClaude(apiKey, pdfBase64, prompt) {
  const result = await httpsPost(
    "api.anthropic.com",
    "/v1/messages",
    { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
          { type: "text", text: prompt }
        ]
      }]
    }
  );
  if (result.status !== 200) {
    if (result.status === 401) throw new Error("Invalid Claude API key.");
    if (result.status === 429) throw new Error("Claude rate limit. Please wait.");
    throw new Error(result.body?.error?.message || "Claude error");
  }
  return result.body?.content?.map(c => c.text || "").join("") || "";
}

// ══════════════════════════════════════════════
//  HTTP SERVER
// ══════════════════════════════════════════════
const server = http.createServer(async (req, res) => {

  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const parsedUrl  = new URL(req.url, `http://localhost:${PORT}`);
  const pathname   = parsedUrl.pathname;

  // ── GET /api/profile ────────────────────────
  if (pathname === "/api/profile" && req.method === "GET") {
    const uid = parsedUrl.searchParams.get("uid");
    if (!uid) { res.writeHead(400); res.end(JSON.stringify({ error: "uid required" })); return; }
    try {
      const profile = await getProfile(uid);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ profile }));
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/profile ───────────────────────
  if (pathname === "/api/profile" && req.method === "POST") {
    let body = "";
    req.on("data", c => { body += c.toString(); });
    req.on("end", async () => {
      try {
        const { uid, profile } = JSON.parse(body);
        if (!uid || !profile) { res.writeHead(400); res.end(JSON.stringify({ error: "uid and profile required" })); return; }
        await saveProfile(uid, profile);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch(e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── POST /api/analyze ───────────────────────
  if (pathname === "/api/analyze" && req.method === "POST") {
    let body = "";
    req.on("data", c => { body += c.toString(); });
    req.on("end", async () => {
      try {
        const { pdfBase64, prompt, apiKey, aiProvider } = JSON.parse(body);

        if (!apiKey)    throw new Error("API key missing. Please update your profile.");
        if (!pdfBase64) throw new Error("No PDF data received.");
        if (!prompt)    throw new Error("No prompt received.");

        const provider = aiProvider || "gemini";
        const keyId    = apiKey.slice(-8);

        console.log(`  [${provider}] Analyzing... (key: ...${keyId})`);
        await rateLimit(provider + "_" + keyId);

        let text = "";
        if      (provider === "gemini")   text = await callGemini(apiKey, pdfBase64, prompt);
        else if (provider === "pagegrid") text = await callPageGrid(apiKey, pdfBase64, prompt);
        else if (provider === "openai")   text = await callOpenAI(apiKey, pdfBase64, prompt);
        else if (provider === "claude")   text = await callClaude(apiKey, pdfBase64, prompt);
        else throw new Error(`Unknown provider: ${provider}`);

        console.log(`  ✓ Done. Response: ${text.length} chars`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text }));

      } catch(e) {
        console.error("  Error:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Static files ─────────────────────────────
  let filePath = pathname === "/" ? "/login.html" : pathname;
  filePath     = path.join(__dirname, filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("404 Not Found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "text/plain" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log("\n─────────────────────────────────────────");
  console.log(`  GEM Checker running at http://localhost:${PORT}`);
  console.log(`  Storage: ${MONGO_URI ? "MongoDB Atlas ✓" : "Local file (profiles.json)"}`);
  console.log("─────────────────────────────────────────");
  console.log("  AI Providers: Gemini | PageGrid | OpenAI | Claude\n");
});
