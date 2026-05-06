// ─────────────────────────────────────────────
//  GEM Checker — Each provider uses native PDF
//
//  Gemini   → PDF directly (inline_data)
//  Claude   → PDF directly (document type)
//  OpenAI   → PDF directly (file content)
//  PageGrid → PDF text (their API limitation)
// ─────────────────────────────────────────────

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const PORT      = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "";

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
//  MONGODB STORAGE (with auto-reconnect)
// ══════════════════════════════════════════════
let mongoClient = null;
let mongoDB     = null;
const LOCAL_DB = path.join(__dirname, "profiles.json");

// Get or create MongoDB connection (reconnect if dropped)
async function getMongoDB() {
  if (!MONGO_URI) return null;
  
  // Check if existing connection still alive
  if (mongoClient && mongoDB) {
    try {
      // Ping to verify connection is alive
      await mongoDB.admin().ping();
      return mongoDB;
    } catch(e) {
      console.warn("MongoDB ping failed, reconnecting...");
      try { await mongoClient.close(); } catch {}
      mongoClient = null;
      mongoDB = null;
    }
  }
  
  // Create new connection
  try {
    const { MongoClient } = require("mongodb");
    mongoClient = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });
    await mongoClient.connect();
    mongoDB = mongoClient.db("gemchecker");
    console.log("✓ MongoDB connected!");
    return mongoDB;
  } catch(e) {
    console.error("MongoDB connect failed:", e.message);
    mongoClient = null;
    mongoDB = null;
    return null;
  }
}

async function getProfile(uid) {
  const db = await getMongoDB();
  if (db) {
    try {
      const doc = await db.collection("profiles").findOne({ uid });
      console.log(`  Profile lookup for ${uid.slice(0,8)}: ${doc ? "FOUND" : "NOT FOUND"}`);
      return doc ? doc.profile : null;
    } catch(e) {
      console.error("MongoDB read error:", e.message);
    }
  }
  return getProfileLocal(uid);
}

async function saveProfile(uid, profile) {
  const db = await getMongoDB();
  if (db) {
    try {
      await db.collection("profiles").updateOne(
        { uid },
        { $set: { uid, profile, updatedAt: new Date() } },
        { upsert: true }
      );
      console.log(`  ✓ Profile saved to MongoDB (${uid.slice(0,8)}...)`);
      // Also save locally as backup
      saveProfileLocal(uid, profile);
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
  } catch { return null; }
}

function saveProfileLocal(uid, profile) {
  try {
    const db = fs.existsSync(LOCAL_DB) ? JSON.parse(fs.readFileSync(LOCAL_DB, "utf8")) : {};
    db[uid] = { profile, updatedAt: new Date().toISOString() };
    fs.writeFileSync(LOCAL_DB, JSON.stringify(db, null, 2));
    console.log(`  ✓ Profile saved locally (${uid.slice(0,8)}...)`);
  } catch(e) { console.error("Local save error:", e.message); }
}

// ══════════════════════════════════════════════
//  HISTORY STORAGE (analysis results per user)
// ══════════════════════════════════════════════
const HISTORY_DB = path.join(__dirname, "history.json");

async function getHistory(uid) {
  const db = await getMongoDB();
  if (db) {
    try {
      const doc = await db.collection("history").findOne({ uid });
      return doc ? doc.results : [];
    } catch(e) {
      console.error("MongoDB history get error:", e.message);
    }
  }
  return getHistoryLocal(uid);
}

async function saveHistory(uid, results) {
  const db = await getMongoDB();
  if (db) {
    try {
      await db.collection("history").updateOne(
        { uid },
        { $set: { uid, results, updatedAt: new Date() } },
        { upsert: true }
      );
      console.log(`  ✓ History saved to MongoDB (${results.length} results)`);
      saveHistoryLocal(uid, results);
      return;
    } catch(e) { console.error("MongoDB history save error:", e.message); }
  }
  saveHistoryLocal(uid, results);
}

async function clearHistory(uid) {
  const db = await getMongoDB();
  if (db) {
    try {
      await db.collection("history").deleteOne({ uid });
      console.log(`  ✓ History cleared from MongoDB`);
      return;
    } catch(e) { console.error("MongoDB history clear error:", e.message); }
  }
  clearHistoryLocal(uid);
}

function getHistoryLocal(uid) {
  try {
    const db = fs.existsSync(HISTORY_DB) ? JSON.parse(fs.readFileSync(HISTORY_DB, "utf8")) : {};
    return db[uid]?.results || [];
  } catch { return []; }
}

function saveHistoryLocal(uid, results) {
  try {
    const db = fs.existsSync(HISTORY_DB) ? JSON.parse(fs.readFileSync(HISTORY_DB, "utf8")) : {};
    db[uid] = { results, updatedAt: new Date().toISOString() };
    fs.writeFileSync(HISTORY_DB, JSON.stringify(db, null, 2));
    console.log(`  ✓ History saved locally (${results.length} results)`);
  } catch(e) { console.error("Local history save error:", e.message); }
}

function clearHistoryLocal(uid) {
  try {
    const db = fs.existsSync(HISTORY_DB) ? JSON.parse(fs.readFileSync(HISTORY_DB, "utf8")) : {};
    delete db[uid];
    fs.writeFileSync(HISTORY_DB, JSON.stringify(db, null, 2));
  } catch(e) { console.error("Local history clear error:", e.message); }
}

// ══════════════════════════════════════════════
//  AI PROVIDERS — each uses native PDF support
// ══════════════════════════════════════════════

// ── 1. GEMINI — PDF native support ──
async function callGemini(apiKey, pdfBase64, prompt) {
  const result = await httpsPost(
    "generativelanguage.googleapis.com",
    `/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {},
    {
      contents: [{
        parts: [
          { inline_data: { mime_type: "application/pdf", data: pdfBase64 } },
          { text: prompt }
        ]
      }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 }
    }
  );
  if (result.status !== 200) {
    const msg = result.body?.error?.message || "Gemini error";
    if (result.status === 429) throw new Error("Gemini quota exceeded. Wait few minutes.");
    if (result.status === 403) throw new Error("Invalid Gemini API key.");
    throw new Error(msg);
  }
  return result.body?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ── 2. CLAUDE — PDF native support ──
async function callClaude(apiKey, pdfBase64, prompt) {
  const result = await httpsPost(
    "api.anthropic.com",
    "/v1/messages",
    {
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
    },
    {
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
          { type: "text",     text: prompt }
        ]
      }]
    }
  );
  if (result.status !== 200) {
    const msg = result.body?.error?.message || "Claude error";
    if (result.status === 401) throw new Error("Invalid Claude API key.");
    if (result.status === 429) throw new Error("Claude rate limit. Please wait.");
    throw new Error(msg);
  }
  return result.body?.content?.map(c => c.text || "").join("") || "";
}

// ── 3. OPENAI — PDF via Files API ──
async function callOpenAI(apiKey, pdfBase64, prompt) {
  // OpenAI accepts PDF as file_data in input_file content type
  const result = await httpsPost(
    "api.openai.com",
    "/v1/chat/completions",
    { "Authorization": `Bearer ${apiKey}` },
    {
      model: "gpt-4o",
      max_tokens: 4096,
      messages: [
        { role: "system", content: "You are a GEM (Government e-Marketplace) procurement expert. Return only valid JSON." },
        {
          role: "user",
          content: [
            {
              type: "file",
              file: {
                filename:  "tender.pdf",
                file_data: `data:application/pdf;base64,${pdfBase64}`
              }
            },
            { type: "text", text: prompt }
          ]
        }
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

// ── 4. PAGEGRID — text only (their API limit) ──
async function callPageGrid(apiKey, pdfBase64, prompt) {
  // PageGrid API doesn't accept PDF — extract text first
  let pdfText = "";
  try {
    const pdfParse  = require("pdf-parse");
    const pdfBuffer = Buffer.from(pdfBase64, "base64");
    const data      = await pdfParse(pdfBuffer);
    pdfText         = data.text || "";
    if (!pdfText.trim()) throw new Error("PDF text extraction failed (scanned image?)");
    console.log(`  PageGrid: extracted ${pdfText.length} chars from ${data.numpages} pages`);
  } catch(e) {
    throw new Error("PDF extraction failed for PageGrid: " + e.message);
  }

  if (pdfText.length > 80000) pdfText = pdfText.slice(0, 80000) + "\n[truncated]";

  const fullPrompt = `${prompt}\n\n=== TENDER DOCUMENT TEXT ===\n${pdfText}\n=== END ===`;

  const result = await httpsPost(
    "api.pagegrid.in",
    "/v1/messages",
    { "api-key": apiKey },
    {
      model:      "claude-opus-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: fullPrompt }]
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

// ══════════════════════════════════════════════
//  HTTP SERVER
// ══════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname  = parsedUrl.pathname;

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

  // ── GET /api/history ────────────────────────
  if (pathname === "/api/history" && req.method === "GET") {
    const uid = parsedUrl.searchParams.get("uid");
    if (!uid) { res.writeHead(400); res.end(JSON.stringify({ error: "uid required" })); return; }
    try {
      const history = await getHistory(uid);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ history }));
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/history ───────────────────────
  if (pathname === "/api/history" && req.method === "POST") {
    let body = "";
    req.on("data", c => { body += c.toString(); });
    req.on("end", async () => {
      try {
        const { uid, results } = JSON.parse(body);
        if (!uid || !results) { res.writeHead(400); res.end(JSON.stringify({ error: "uid and results required" })); return; }
        await saveHistory(uid, results);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch(e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── DELETE /api/history ─────────────────────
  if (pathname === "/api/history" && req.method === "DELETE") {
    const uid = parsedUrl.searchParams.get("uid");
    if (!uid) { res.writeHead(400); res.end(JSON.stringify({ error: "uid required" })); return; }
    try {
      await clearHistory(uid);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
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

        console.log(`\n  [${provider}] Analyzing... (key: ...${keyId})`);
        await rateLimit(provider + "_" + keyId);

        let text = "";
        if      (provider === "gemini")   text = await callGemini(apiKey, pdfBase64, prompt);
        else if (provider === "claude")   text = await callClaude(apiKey, pdfBase64, prompt);
        else if (provider === "openai")   text = await callOpenAI(apiKey, pdfBase64, prompt);
        else if (provider === "pagegrid") text = await callPageGrid(apiKey, pdfBase64, prompt);
        else throw new Error(`Unknown provider: ${provider}`);

        console.log(`  ✓ ${provider} response: ${text.length} chars\n`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text }));

      } catch(e) {
        console.error("  ✗ Error:", e.message);
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
  console.log(`  GEM Checker running on port ${PORT}`);
  console.log(`  Storage: ${MONGO_URI ? "MongoDB Atlas ✓" : "Local file"}`);
  console.log("─────────────────────────────────────────");
  console.log("  AI Providers (PDF handling):");
  console.log("    • Gemini   → native PDF support ✓");
  console.log("    • Claude   → native PDF support ✓");
  console.log("    • OpenAI   → native PDF support ✓");
  console.log("    • PageGrid → text extraction (their limit)\n");
});
app.get("/api/gst/:gstin", async (req, res) => {
  const gstin = req.params.gstin;

  try {
    const response = await fetch(
      `https://gst-verification-api-get-profile-returns-data.p.rapidapi.com/v1/gstin/${gstin}`,
      {
        method: "GET",
        headers: {
          "x-rapidapi-key": "a839f030d5msha9d8a1bf497fb2fp156ab6jsn9b535c31b7f1",
          "x-rapidapi-host": "gst-verification-api-get-profile-returns-data.p.rapidapi.com"
        }
      }
    );

    const data = await response.json();

    console.log("GST API response:", data); // debug

    res.json({
      companyName: data?.data?.lgnm || "",   // Legal Name
      tradeName: data?.data?.tradeNam || "",
      state: data?.data?.pradr?.addr?.stcd || ""
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "GST fetch failed" });
  }
});
