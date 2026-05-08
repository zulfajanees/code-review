// Reviews are generated via backend API to keep secrets off the client.
const REVIEW_API_ENDPOINT = "/api/review";

// === DOM ===
const analyzeButton = document.getElementById("analyze-button");
const analyzeLabel = document.getElementById("analyze-label");
const analyzeSpinner = document.getElementById("analyze-spinner");

const languageSelect = document.getElementById("language-select");
const focusInput = document.getElementById("focus-input");
const codeInput = document.getElementById("code-input");

const scoreValueEl = document.getElementById("score-value");
const scoreLabelEl = document.getElementById("score-label");
const scoreSubtextEl = document.getElementById("score-subtext");

const scoreCorrectnessFill = document.getElementById("score-correctness");
const scoreSecurityFill = document.getElementById("score-security");
const scoreMaintainabilityFill = document.getElementById("score-maintainability");

const scoreCorrectnessLabel = document.getElementById("score-correctness-label");
const scoreSecurityLabel = document.getElementById("score-security-label");
const scoreMaintainabilityLabel = document.getElementById("score-maintainability-label");

const reviewOutput = document.getElementById("review-output");
const explanationOutput = document.getElementById("explanation-output");
const issuesContainer = document.getElementById("issues-container");
const copyReviewButton = document.getElementById("copy-review");

function setLoading(isLoading) {
  if (!analyzeButton) return;
  analyzeButton.disabled = isLoading;
  if (analyzeSpinner) analyzeSpinner.classList.toggle("hidden", !isLoading);
  if (analyzeLabel) analyzeLabel.textContent = isLoading ? "Analyzing..." : "Run AI Review";
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function scoreLabel(score) {
  const s = Number(score);
  if (s >= 90) return "Excellent";
  if (s >= 75) return "Good";
  if (s >= 60) return "Fair";
  if (s >= 40) return "Needs improvement";
  return "Critical";
}

function stripJsonFences(text) {
  return (text || "")
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
  try {
    return JSON.parse(candidate);
  } catch {
    // Fallback minimal structure.
    return {
      overview: candidate,
      suggestions: "",
      explanation: "The model did not return valid JSON. Showing raw output instead.",
      score: 60,
      subscores: { correctness: 60, security: 60, maintainability: 60 },
      issues: [],
    };
  }
}

function getCandidateText(result) {
  const parts = result?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return "";
  // Gemini often returns parts[0].text
  const text = parts.map((p) => p?.text || "").join("\n").trim();
  return text;
}

function setOutput(box, content) {
  if (!box) return;
  box.textContent = content ?? "";
}

function renderScores(data) {
  const score = clamp(Number(data?.score ?? 0), 0, 100);
  const subs = data?.subscores || {};

  const correctness = clamp(Number(subs?.correctness ?? score), 0, 100);
  const security = clamp(Number(subs?.security ?? score), 0, 100);
  const maintainability = clamp(
    Number(subs?.maintainability ?? score),
    0,
    100
  );

  scoreValueEl.textContent = score ? String(score) : "—";
  scoreLabelEl.textContent = score ? scoreLabel(score) : "Awaiting analysis";
  if (scoreSubtextEl) scoreSubtextEl.textContent = "Scores are estimates based on the AI review.";

  scoreCorrectnessFill.style.width = `${correctness}%`;
  scoreSecurityFill.style.width = `${security}%`;
  scoreMaintainabilityFill.style.width = `${maintainability}%`;

  scoreCorrectnessLabel.textContent = correctness ? `${correctness}/100` : "—";
  scoreSecurityLabel.textContent = security ? `${security}/100` : "—";
  scoreMaintainabilityLabel.textContent = maintainability
    ? `${maintainability}/100`
    : "—";
}

function renderReviewAndExplanation(data) {
  const overview = data?.overview ? String(data.overview) : "No overview provided.";
  const suggestions = data?.suggestions ? String(data.suggestions) : "";
  const explanation = data?.explanation ? String(data.explanation) : "No explanation provided.";

  const reviewText = suggestions
    ? `${overview}\n\nSuggestions:\n${suggestions}`
    : overview;

  setOutput(reviewOutput, reviewText);
  setOutput(explanationOutput, explanation);
}

function renderIssues(data) {
  const issues = Array.isArray(data?.issues) ? data.issues : [];
  issuesContainer.innerHTML = "";

  if (issues.length === 0) {
    const div = document.createElement("div");
    div.className = "placeholder";
    div.textContent =
      "No explicit issues returned. This does not guarantee the code is bug-free.";
    issuesContainer.appendChild(div);
    return;
  }

  for (const issue of issues) {
    const card = document.createElement("div");
    card.className = "issue-card";

    const top = document.createElement("div");
    top.className = "issue-top";

    const title = document.createElement("div");
    title.className = "issue-title";
    title.textContent = issue.title || "Issue";

    const badge = document.createElement("span");
    const severity = (issue.severity || "info").toLowerCase();
    badge.className = "badge";
    if (severity === "error" || severity === "critical") {
      badge.classList.add("error");
      badge.textContent = "Error";
    } else if (severity === "warning" || severity === "medium") {
      badge.classList.add("warning");
      badge.textContent = "Warning";
    } else {
      badge.classList.add("info");
      badge.textContent = "Info";
    }

    top.appendChild(title);
    top.appendChild(badge);
    card.appendChild(top);

    if (issue.location) {
      const loc = document.createElement("div");
      loc.className = "issue-loc";
      loc.textContent = issue.location;
      card.appendChild(loc);
    }

    if (issue.message) {
      const msg = document.createElement("div");
      msg.className = "issue-message";
      msg.textContent = issue.message;
      card.appendChild(msg);
    }

    if (issue.recommendation) {
      const rec = document.createElement("div");
      rec.className = "issue-rec";
      rec.textContent = `Recommendation: ${issue.recommendation}`;
      card.appendChild(rec);
    }

    issuesContainer.appendChild(card);
  }
}

async function callReviewApi({ code, language, focus }) {
  const response = await fetch(REVIEW_API_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, language, focus }),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const message = payload?.error || `Request failed (${response.status}).`;
    throw new Error(message);
  }

  if (payload?.review && typeof payload.review === "object") {
    return payload.review;
  }

  if (typeof payload?.review === "string") {
    return parseReviewJson(payload.review);
  }

  throw new Error("Invalid review response from server.");
}

async function runReview() {
  const code = (codeInput.value || "").trim();
  const language = languageSelect?.value === "auto" ? "" : (languageSelect?.value || "");
  const focus = focusInput?.value ? focusInput.value.trim() : "";

  if (code.length < 40) {
    reviewOutput.textContent = "Paste more code (at least ~40 characters) for a meaningful review.";
    return;
  }

  setLoading(true);
  setOutput(reviewOutput, "Analyzing code with Gemini...");
  setOutput(explanationOutput, "Generating explanation and reasoning...");
  issuesContainer.innerHTML = '<div class="placeholder">Scanning for issues and warnings...</div>';

  try {
    const reviewJson = await callReviewApi({ code, language, focus });
    renderScores(reviewJson);
    renderReviewAndExplanation(reviewJson);
    renderIssues(reviewJson);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error occurred.";
    setOutput(reviewOutput, message);
    setOutput(explanationOutput, "No explanation available due to error.");
    issuesContainer.innerHTML =
      '<div class="placeholder">No issues available due to error.</div>';
  } finally {
    setLoading(false);
  }
}

analyzeButton?.addEventListener("click", runReview);

copyReviewButton?.addEventListener("click", async () => {
  const text = reviewOutput?.innerText?.trim() || "";
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copyReviewButton.textContent = "Copied!";
    setTimeout(() => {
      copyReviewButton.textContent = "Copy Review";
    }, 1200);
  } catch {
    alert("Unable to copy to clipboard in this browser.");
  }
});
