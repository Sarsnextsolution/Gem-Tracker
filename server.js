// ─────────────────────────────────────────────
//  GEM Checker — Multi-Provider AI Server
//  Supports: Gemini (free), OpenAI, Claude
//
//  Run: node server.js
//  Open: http://localhost:3000/login.html
// ─────────────────────────────────────────────

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");
const url   = require("url");

const PORT = 3000;

const MIME = {
  ".html": "text/html",
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".json": "application/json",
};

// ── Rate limiter (5s between calls per key) ──
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

// ── HTTPS post helper ────────────────────────
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
//  PROVIDER HANDLERS
// ══════════════════════════════════════════════

// ── 1. Gemini ────────────────────────────────
async function callGemini(apiKey, pdfBase64, prompt) {
  const model   = "gemini-2.0-flash";
  const apiPath = `/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const result = await httpsPost(
    "generativelanguage.googleapis.com",
    apiPath,
    {},
    {
      contents: [{
        parts: [
          { inline_data: { mime_type: "application/pdf", data: pdfBase64 } },
          { text: prompt }
        ]
      }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
    }
  );

  if (result.status !== 200) {
    const msg = result.body?.error?.message || "Gemini API error";
    let userMsg = msg;
    if (result.status === 429) userMsg = "Gemini free tier quota exceeded. Please wait a few minutes and try again.";
    if (result.status === 403) userMsg = "Invalid Gemini API key. Please check your key at aistudio.google.com/app/apikey";
    throw new Error(userMsg);
  }

  return result.body?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ── 2. OpenAI ────────────────────────────────
async function callOpenAI(apiKey, pdfBase64, prompt) {
  // OpenAI doesn't support PDF directly — send as base64 image-style text
  // We use GPT-4o which can handle file content via text
  const result = await httpsPost(
    "api.openai.com",
    "/v1/chat/completions",
    { "Authorization": `Bearer ${apiKey}` },
    {
      model: "gpt-4o",
      max_tokens: 2048,
      messages: [
        {
          role: "system",
          content: "You are a GEM (Government e-Marketplace) procurement expert. Analyze tender documents and return structured JSON."
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `The following is a base64-encoded PDF of a GEM tender document. Please analyze it.\n\n${prompt}`
            },
            {
              type: "text",
              text: `PDF Data (base64): data:application/pdf;base64,${pdfBase64}`
            }
          ]
        }
      ]
    }
  );

  if (result.status !== 200) {
    const msg = result.body?.error?.message || "OpenAI API error";
    let userMsg = msg;
    if (result.status === 429) userMsg = "OpenAI rate limit exceeded. Please wait and try again.";
    if (result.status === 401) userMsg = "Invalid OpenAI API key. Please check your key at platform.openai.com/api-keys";
    if (result.status === 402) userMsg = "OpenAI billing issue. Please add credits at platform.openai.com";
    throw new Error(userMsg);
  }

  return result.body?.choices?.[0]?.message?.content || "";
}

// ── 3. Claude (Anthropic) ────────────────────
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
      max_tokens: 2048,
      messages: [{
        role: "user",
        content: [
          {
            type:   "document",
            source: { type: "base64", media_type: "application/pdf", data: pdfBase64 }
          },
          { type: "text", text: prompt }
        ]
      }]
    }
  );

  if (result.status !== 200) {
    const msg = result.body?.error?.message || "Claude API error";
    let userMsg = msg;
    if (result.status === 429) userMsg = "Claude API rate limit hit. Please wait a moment.";
    if (result.status === 401) userMsg = "Invalid Claude API key. Please check your key at console.anthropic.com";
    if (result.status === 402) userMsg = "Claude billing issue. Please add credits at console.anthropic.com";
    throw new Error(userMsg);
  }

  return result.body?.content?.map(c => c.text || "").join("") || "";
}

// ── 4. PageGrid (Affordable Claude via India) ──
const pdf = require("pdf-parse");

async function callPageGrid(apiKey, pdfBase64, prompt) {
  try {
    const pdfBuffer = Buffer.from(pdfBase64, "base64");

    const pdfData = await pdf(pdfBuffer);

    const extractedText = pdfData.text;

    if (!extractedText || extractedText.trim().length < 50) {
      throw new Error("Could not extract text from PDF");
    }

    const result = await httpsPost(
      "api.pagegrid.in",
      "/v1/messages",
      {
        "api-key": apiKey,
      },
      {
        model: "claude-opus-4-6",
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: `
Below is extracted GEM tender PDF content:

${extractedText}

${prompt}

Return only valid JSON.
`
          }
        ]
      }
    );

    if (result.status !== 200) {
      throw new Error(
        result.body?.error?.message ||
        result.body?.message ||
        "PageGrid API error"
      );
    }

    return result.body?.content?.map(c => c.text || "").join("") || "";

  } catch (err) {
    throw new Error("PageGrid PDF parsing failed: " + err.message);
  }
}

// ══════════════════════════════════════════════
//  HTTP SERVER
// ══════════════════════════════════════════════
const server = http.createServer(async (req, res) => {

  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const parsedUrl = url.parse(req.url);
  // Health check route
if (parsedUrl.pathname === "/health") {
  res.writeHead(200, {
    "Content-Type": "application/json"
  });

  res.end(JSON.stringify({
    status: "ok",
    message: "Server running successfully"
  }));
  return;
}

  // ── POST /api/analyze ───────────────────
  if (parsedUrl.pathname === "/api/analyze" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk.toString(); });

    req.on("end", async () => {
      try {
        const { pdfBase64, prompt, apiKey, aiProvider } = JSON.parse(body);

        // Validate
        if (!apiKey)    throw new Error("API key is missing. Please update your profile.");
        if (!pdfBase64) throw new Error("No PDF data received.");
        if (!prompt)    throw new Error("No prompt received.");

        const provider = aiProvider || "gemini";

        // Validate PageGrid key format
        if (provider === "pagegrid" && !apiKey.startsWith("sk-pgrid-")) {
          throw new Error("Invalid PageGrid key format. Key should start with sk-pgrid-");
        }
        const keyId    = apiKey.slice(-8);

        console.log(`  [${provider}] Analyzing... (key: ...${keyId})`);

        // Rate limit
        await rateLimit(provider + "_" + keyId);

        // Call the right provider
        let text = "";
        if      (provider === "gemini")   text = await callGemini(apiKey, pdfBase64, prompt);
        else if (provider === "openai")   text = await callOpenAI(apiKey, pdfBase64, prompt);
        else if (provider === "claude")   text = await callClaude(apiKey, pdfBase64, prompt);
        else if (provider === "pagegrid") text = await callPageGrid(apiKey, pdfBase64, prompt);
        else throw new Error(`Unknown provider: ${provider}`);

        console.log(`  Done. Response: ${text.length} chars`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text }));

      } catch (err) {
        console.error("  Error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    return;
  }

  // ── GET /api/profile?uid=xxx ─────────────
  if (parsedUrl.pathname === "/api/profile" && req.method === "GET") {
    const params = new URLSearchParams(parsedUrl.query || "");
    const uid    = params.get("uid");
    if (!uid) { res.writeHead(400); res.end(JSON.stringify({error:"uid required"})); return; }

    const dbPath = path.join(__dirname, "profiles.json");
    try {
      const db      = fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath, "utf8")) : {};
      const profile = db[uid] || null;
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ profile }));
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // ── POST /api/profile ─────────────────────
  if (parsedUrl.pathname === "/api/profile" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const { uid, profile } = JSON.parse(body);
        if (!uid || !profile) { res.writeHead(400); res.end(JSON.stringify({error:"uid and profile required"})); return; }

        const dbPath = path.join(__dirname, "profiles.json");
        const db     = fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath, "utf8")) : {};
        db[uid]      = { ...profile, updatedAt: new Date().toISOString() };
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

        console.log(`  ✓ Profile saved for uid: ${uid.slice(0,8)}...`);
        res.writeHead(200, {"Content-Type":"application/json"});
        res.end(JSON.stringify({ success: true }));
      } catch(e) {
        res.writeHead(500); res.end(JSON.stringify({error:e.message}));
      }
    });
    return;
  }

  // ── Static files ────────────────────────
  let filePath = parsedUrl.pathname === "/" ? "/login.html" : parsedUrl.pathname;
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
  console.log("─────────────────────────────────────────");
  console.log("  Supported AI providers:");
  console.log("    • Gemini    (Free     — aistudio.google.com)");
  console.log("    • PageGrid  (Affordable — pagegrid.in)");
  console.log("    • OpenAI    (Paid     — platform.openai.com)");
  console.log("    • Claude    (Paid     — console.anthropic.com)");
  console.log("");
});
