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
const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";

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

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set.");
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: "You produce high-quality code review feedback." }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.2
      }
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${details}`);
  }

  const data = await response.json();
  const content =
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text)
      .filter(Boolean)
      .join("\n")
      .trim() || "";

  if (!content) {
    const blockedReason = data?.promptFeedback?.blockReason;
    if (blockedReason) {
      throw new Error(`Gemini response blocked: ${blockedReason}`);
    }
    throw new Error("No content returned from model.");
  }
  return content;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
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

    if (req.method === "POST" && url.pathname === "/api/review") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) {
          req.destroy();
        }
      });

      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const { code, language, notes, focus } = parsed;
          if (!code || typeof code !== "string" || code.trim().length < 10) {
            sendJson(res, 400, {
              error: "Please provide at least 10 characters of code."
            });
            return;
          }

          const prompt = buildPrompt({ code, language, notes, focus });
          const reviewText = await callGemini(prompt);
          const review = parseReviewJson(reviewText);
          sendJson(res, 200, { review });
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : "Unknown server error."
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
  console.log(`AI code review app running at http://localhost:${port}`);
});
