const MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

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

function sendJson(res, statusCode, payload) {
  res.status(statusCode).json(payload);
}

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set.");
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  if (typeof req.body === "object") return req.body;
  return {};
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  try {
    const parsed = parseBody(req);
    const { code, language, notes, focus } = parsed;

    if (!code || typeof code !== "string" || code.trim().length < 10) {
      sendJson(res, 400, { error: "Please provide at least 10 characters of code." });
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
}
