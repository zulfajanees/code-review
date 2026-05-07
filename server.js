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
const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

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
    "You are a senior staff engineer reviewing a pull request.",
    "Return your response as markdown with these sections in order:",
    "1) Overview",
    "2) Critical Issues",
    "3) Suggestions",
    "4) Improved Example",
    "",
    "Rules:",
    "- Be direct, practical, and specific.",
    "- Prioritize correctness, security, performance, and readability.",
    "- If no critical issues exist, explicitly say that.",
    "- For Improved Example, provide a concise revised snippet only.",
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

async function callOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set.");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: "You produce high-quality code review feedback."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${details}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
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
          const review = await callOpenAI(prompt);
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
