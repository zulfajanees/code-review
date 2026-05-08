import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

loadEnv(path.join(__dirname, ".env"));

const port = Number(process.env.PORT) || 3000;
const primaryModel = process.env.GEMINI_MODEL || "gemini-1.5-flash-8b";
const fallbackModels = [
  "gemini-1.5-flash",
  "gemini-1.5-flash-latest",
  "gemini-2.0-flash"
];
const apiTimeoutMs = Number(process.env.API_TIMEOUT_MS) || 30000;

// ── API KEY ROTATION ──────────────────────────────────────────────
// Add all your Gemini API keys here (one per Gmail account)
function getApiKeys() {
  const keys = [];
  if (process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY);
  if (process.env.GEMINI_API_KEY_2) keys.push(process.env.GEMINI_API_KEY_2);
  if (process.env.GEMINI_API_KEY_3) keys.push(process.env.GEMINI_API_KEY_3);
  if (keys.length === 0) throw new Error("No GEMINI_API_KEY configured.");
  return keys;
}

// Track which keys are quota-exceeded and when they reset
const exhaustedKeys = new Map(); // key -> timestamp when exhausted
const KEY_COOLDOWN_MS = 60 * 1000; // 1 minute cooldown before retrying exhausted key

function getAvailableKey() {
  const keys = getApiKeys();
  const now = Date.now();

  for (const key of keys) {
    const exhaustedAt = exhaustedKeys.get(key);
    if (!exhaustedAt || now - exhaustedAt > KEY_COOLDOWN_MS) {
      if (exhaustedAt) {
        exhaustedKeys.delete(key); // cooldown passed, try again
        console.log(`Key ...${key.slice(-4)} cooldown passed, retrying.`);
      }
      return key;
    }
  }

  // All keys exhausted — return the one that's been waiting longest
  const oldest = [...exhaustedKeys.entries()].sort((a, b) => a[1] - b[1])[0];
  console.warn("All API keys exhausted. Using oldest key as last resort.");
  return oldest[0];
}

function markKeyExhausted(key) {
  exhaustedKeys.set(key, Date.now());
  console.warn(`Key ...${key.slice(-4)} marked as quota-exceeded. Will retry after ${KEY_COOLDOWN_MS / 1000}s.`);
}
// ─────────────────────────────────────────────────────────────────

function loadEnv(envPath) {
  try {
    const content = fsSync.readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // Ignore missing .env file.
  }
}

function buildPrompt({ code, language, notes, focus }) {
  return [
    "You are a senior staff engineer performing a code review and analysis.",
    "Return STRICT JSON only. No markdown, no code fences, no prose.",
    "",
    "JSON schema:",
    "{",
    '  "overview": string,',
    '  "suggestions": string,',
    '  "explanation": string,',
    '  "score": number,',
    '  "subscores": {',
    '    "correctness": number,',
    '    "security": number,',
    '    "maintainability": number',
    "  },",
    '  "issues": [',
    "    {",
    '      "title": string,',
    '      "severity": "error" | "warning" | "info",',
    '      "location": string,',
    '      "message": string,',
    '      "recommendation": string',
    "    }",
    "  ]",
    "}",
    "",
    "Rules:",
    "- Prioritize correctness, security, performance, and readability.",
    "- If no issues exist, return an empty issues array.",
    "- Keep output concise and practical.",
    "",
    `Language: ${language || "Unknown"}`,
    `Focus Areas: ${focus || "General review"}`,
    `Author Notes: ${notes || "None"}`,
    "",
    "Code to review:",
    "```",
    code,
    "```"
  ].join("\n");
}

function stripJsonFences(text) {
  return String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function extractFirstJsonObject(text) {
  const cleaned = stripJsonFences(text);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return cleaned;
  return cleaned.slice(start, end + 1);
}

function parseReviewJson(text) {
  const candidate = extractFirstJsonObject(text);
  return JSON.parse(candidate);
}

function escapeHtml(text) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  };
  return String(text || "").replace(/[&<>"']/g, (char) => map[char]);
}

function getDefaultReview(errorMsg) {
  return {
    overview: "Unable to generate review due to API limitations.",
    suggestions: "All API keys are currently quota-exceeded. Please wait a minute and try again.",
    explanation: errorMsg || "The AI model could not generate a response due to quota limits.",
    score: 50,
    subscores: { correctness: 50, security: 50, maintainability: 50 },
    issues: [
      {
        title: "Quota Exceeded on All Keys",
        severity: "warning",
        location: "API",
        message: "All configured Gemini API keys have exceeded their free tier quota.",
        recommendation: "Wait 1 minute and try again. Keys rotate automatically."
      }
    ]
  };
}

async function callGeminiWithKey(prompt, model, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), apiTimeoutMs);

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    console.log(`Calling Gemini API: ${endpoint} with model ${model}`);

    const response = await fetch(endpoint, {
      signal: controller.signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: "You produce high-quality code review feedback." }]
        },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 }
      })
    });

    if (!response.ok) {
      const details = await response.text();
      console.error(`Gemini API error (${response.status}): ${details.slice(0, 500)}`);

      const error = new Error(`Gemini API error (${response.status}): ${details.slice(0, 300)}`);
      error.status = response.status;
      throw error;
    }

    const data = await response.json();
    console.log(`Gemini API response received for model ${model}`);

    const content =
      data?.candidates?.[0]?.content?.parts
        ?.map((part) => part?.text)
        .filter(Boolean)
        .join("\n")
        .trim() || "";

    if (!content) {
      const blockedReason = data?.promptFeedback?.blockReason;
      if (blockedReason) {
        console.error(`Gemini response blocked: ${blockedReason}`);
        throw new Error(`Gemini response blocked: ${blockedReason}`);
      }
      console.error("No content returned from Gemini model");
      throw new Error("No content returned from model.");
    }

    console.log(`Successfully received content from model ${model}, length: ${content.length}`);
    return content;
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error(`Gemini API call timed out after ${apiTimeoutMs}ms for model ${model}`);
      throw new Error(`API call timed out after ${apiTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function callGemini(prompt) {
  const models = [primaryModel, ...fallbackModels];
  const errors = [];

  for (const model of models) {
    // Try each available key for this model
    const keys = getApiKeys();
    for (let attempt = 0; attempt < keys.length; attempt++) {
      const apiKey = getAvailableKey();
      try {
        console.log(`Trying model=${model} key=...${apiKey.slice(-4)}`);
        const result = await callGeminiWithKey(prompt, model, apiKey);
        console.log(`Success with model=${model} key=...${apiKey.slice(-4)}`);
        return result;
      } catch (err) {
        if (err.status === 429) {
          // Quota exceeded — mark key and try next
          markKeyExhausted(apiKey);
          errors.push(`key ...${apiKey.slice(-4)} quota exceeded`);
          continue;
        }
        // Other error — try next model
        errors.push(`model ${model}: ${err.message}`);
        break;
      }
    }
  }

  throw new Error(`All attempts failed: ${errors.join("; ")}`);
}

function sendJson(res, statusCode, payload) {
  // Add CORS headers for Vercel deployment
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    // Handle CORS preflight requests
    if (req.method === "OPTIONS") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400"
      });
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/review") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy();
      });

      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const { code, language, notes, focus } = parsed;
          if (!code || typeof code !== "string" || code.trim().length < 10) {
            sendJson(res, 400, { error: "Please provide at least 10 characters of code." });
            return;
          }

          const prompt = buildPrompt({ code, language, notes, focus });

          try {
            const reviewText = await callGemini(prompt);
            const review = parseReviewJson(reviewText);
            sendJson(res, 200, { review, model: primaryModel });
          } catch (apiError) {
            console.error("API call failed:", apiError.message);
            const fallbackReview = getDefaultReview(apiError.message);
            sendJson(res, 200, {
              review: fallbackReview,
              model: "fallback",
              warning: escapeHtml(apiError.message)
            });
          }
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? escapeHtml(error.message) : "Unknown server error."
          });
        }
      });
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed." });
      return;
    }

    const safePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.join(publicDir, safePath);
    if (!filePath.startsWith(publicDir)) {
      sendJson(res, 403, { error: "Forbidden." });
      return;
    }

    const fileContent = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
    res.end(fileContent);
  } catch {
    sendJson(res, 404, { error: "Not found." });
  }
});

server.listen(port, () => {
  const keyCount = getApiKeys().length;
  console.log(`AI code review app running at http://localhost:${port}`);
  console.log(`Primary model: ${primaryModel}, Fallback: ${fallbackModel}`);
  console.log(`API key rotation enabled with ${keyCount} key(s).`);
});
