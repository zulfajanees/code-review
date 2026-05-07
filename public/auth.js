/**
 * Frontend-only demo authentication.
 * - Stores users + hashed passwords in localStorage (for demo).
 * - Stores session token in localStorage or sessionStorage (based on "remember me").
 *
 * NOTE: This is NOT secure for real production apps. It exists to demonstrate UI + flow
 * without any backend.
 */

const USERS_KEY = "codesense.users.v1";
const SESSION_LOCAL_KEY = "codesense.session.local.v1";
const SESSION_SESSION_KEY = "codesense.session.session.v1";

const STORAGE = {
  local: window.localStorage,
  session: window.sessionStorage,
};

const $ = (id) => document.getElementById(id);

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeEmail(email) {
  return (email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function getUsers() {
  const raw = window.localStorage.getItem(USERS_KEY);
  const parsed = safeJsonParse(raw, {});
  // stored format: { [emailLower]: userRecord }
  return parsed && typeof parsed === "object" ? parsed : {};
}

function setUsers(users) {
  window.localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

function bytesToBase64(bytes) {
  const bin = String.fromCharCode(...bytes);
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function sha256Base64(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToBase64(new Uint8Array(digest));
}

async function hashPasswordWithSalt(saltB64, password) {
  // Deterministic demo hash: SHA-256(salt + ":" + password)
  return sha256Base64(`${saltB64}:${password}`);
}

function randomBytesBase64(byteLen = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLen));
  return bytesToBase64(bytes);
}

function getSessionFromStorage(storage) {
  const raw = storage.getItem(SESSION_LOCAL_KEY) || storage.getItem(SESSION_SESSION_KEY);
  if (!raw) return null;
  const parsed = safeJsonParse(raw, null);
  if (!parsed || typeof parsed !== "object") return null;
  if (!parsed.token || !parsed.username || !parsed.email) return null;
  return parsed;
}

export function getSession() {
  // Prefer localStorage (remember me), then sessionStorage.
  return getSessionFromStorage(STORAGE.local) || getSessionFromStorage(STORAGE.session);
}

function setSession(session, rememberMe) {
  const storage = rememberMe ? STORAGE.local : STORAGE.session;
  storage.setItem(
    rememberMe ? SESSION_LOCAL_KEY : SESSION_SESSION_KEY,
    JSON.stringify(session)
  );
  // Keep the other storage clean
  STORAGE.local.removeItem(SESSION_SESSION_KEY);
  STORAGE.session.removeItem(SESSION_LOCAL_KEY);
}

export function clearSession() {
  STORAGE.local.removeItem(SESSION_LOCAL_KEY);
  STORAGE.session.removeItem(SESSION_SESSION_KEY);
}

export async function register({ username, email, password }) {
  const users = getUsers();
  const normalizedEmail = normalizeEmail(email);

  const user = users[normalizedEmail];
  if (user) {
    throw new Error("An account with this email already exists.");
  }

  const saltB64 = randomBytesBase64(16);
  const passwordHash = await hashPasswordWithSalt(saltB64, password);

  users[normalizedEmail] = {
    username: (username || "").trim(),
    email: normalizedEmail,
    saltB64,
    passwordHash,
    createdAt: Date.now(),
  };
  setUsers(users);

  return { username: users[normalizedEmail].username, email: normalizedEmail };
}

export async function login({ email, password, rememberMe }) {
  const users = getUsers();
  const normalizedEmail = normalizeEmail(email);

  const user = users[normalizedEmail];
  if (!user) {
    throw new Error("Invalid email or password.");
  }

  const computed = await hashPasswordWithSalt(user.saltB64, password);
  if (computed !== user.passwordHash) {
    throw new Error("Invalid email or password.");
  }

  const token = randomBytesBase64(20);
  setSession(
    {
      token,
      username: user.username,
      email: user.email,
      issuedAt: Date.now(),
    },
    rememberMe
  );

  return { username: user.username, email: user.email };
}

export async function socialLogin({ provider, rememberMe }) {
  // Demo-only: creates (or reuses) a user based on provider.
  const stableSuffix = String(Math.floor(Math.random() * 9999)).padStart(4, "0");
  const email = `demo+${provider}-${stableSuffix}@codesense.local`;
  const username = `${provider[0].toUpperCase() + provider.slice(1)}User${stableSuffix}`;
  const password = randomBytesBase64(12);

  const users = getUsers();
  if (!users[normalizeEmail(email)]) {
    await register({ username, email, password });
  }

  // We just created it with a random password, so login now needs that value.
  // Since we didn't store the random password anywhere, we instead create a deterministic one:
  // For demo purposes, we re-hash using the same generated password (still within this function).
  // Then we directly set a session without verifying.
  const session = { token: randomBytesBase64(20), username, email: normalizeEmail(email), issuedAt: Date.now() };
  setSession(session, rememberMe);
  return { username: session.username, email: session.email };
}

export function ensureAuthenticated({ redirectTo = "./login.html" } = {}) {
  const session = getSession();
  if (!session) {
    window.location.href = redirectTo;
    return null;
  }
  return session;
}

export function ensureUnauthenticated({ redirectTo = "./dashboard.html" } = {}) {
  const session = getSession();
  if (session) {
    window.location.href = redirectTo;
    return false;
  }
  return true;
}

export function setModalVisible(modalEl, visible) {
  if (!modalEl) return;
  modalEl.classList.toggle("show", Boolean(visible));
}

export function initDarkModeToggle() {
  const root = document.documentElement;
  const stored = window.localStorage.getItem("codesense.theme");
  if (stored === "light") root.classList.add("light-theme");

  const btn = document.getElementById("theme-toggle");
  const icon = document.getElementById("theme-icon");
  if (!btn) return;

  const syncIcon = () => {
    const isLight = root.classList.contains("light-theme");
    if (icon) icon.textContent = isLight ? "☀️" : "🌙";
  };
  syncIcon();

  btn.addEventListener("click", () => {
    const isLight = root.classList.toggle("light-theme");
    window.localStorage.setItem("codesense.theme", isLight ? "light" : "dark");
    syncIcon();
  });
}

export function computePasswordStrength(password) {
  const p = password || "";
  let score = 0;

  if (p.length >= 8) score += 20;
  if (p.length >= 12) score += 20;
  if (/[a-z]/.test(p)) score += 15;
  if (/[A-Z]/.test(p)) score += 15;
  if (/[0-9]/.test(p)) score += 15;
  if (/[^A-Za-z0-9]/.test(p)) score += 15;

  // Penalize very short
  if (p.length < 6) score = Math.min(score, 10);
  score = Math.max(0, Math.min(100, score));

  let label = "Weak";
  if (score >= 80) label = "Strong";
  else if (score >= 60) label = "Good";
  else if (score >= 40) label = "Fair";

  return { score, label };
}

function showInlineError(el, message) {
  if (!el) return;
  el.textContent = message || "";
}

function getAuthPageMode() {
  const body = document.body;
  return body?.getAttribute("data-auth-page") || "";
}

function initLoginPage() {
  const form = document.getElementById("login-form");
  if (!form) return;

  if (!ensureUnauthenticated({ redirectTo: "./dashboard.html" })) return;

  const emailEl = $("login-email");
  const passwordEl = $("login-password");
  const rememberEl = $("remember-me");
  const errorEl = $("login-error");

  const toggleBtn = $("toggle-login-password");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const isHidden = passwordEl.type === "password";
      passwordEl.type = isHidden ? "text" : "password";
      toggleBtn.textContent = isHidden ? "Hide" : "Show";
    });
  }

  const forgotBtn = $("forgot-password-btn");
  const forgotModal = $("forgot-modal");
  if (forgotBtn && forgotModal) {
    forgotBtn.addEventListener("click", (e) => {
      e.preventDefault();
      setModalVisible(forgotModal, true);
    });
  }

  const modalClose = document.querySelectorAll("[data-modal-close]");
  modalClose.forEach((btn) => {
    btn.addEventListener("click", () => {
      const modal = btn.closest(".modal-overlay");
      setModalVisible(modal, false);
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showInlineError(errorEl, "");

    const email = emailEl?.value || "";
    const password = passwordEl?.value || "";

    if (!isValidEmail(email)) {
      showInlineError(errorEl, "Enter a valid email address.");
      return;
    }
    if (!password) {
      showInlineError(errorEl, "Password is required.");
      return;
    }

    const rememberMe = Boolean(rememberEl?.checked);
    const submitBtn = $("login-submit");
    const spinner = $("login-spinner");
    const prevText = submitBtn?.innerHTML || "";

    submitBtn.disabled = true;
    if (spinner) spinner.classList.remove("hidden");

    try {
      await login({ email, password, rememberMe });
      window.location.href = "./dashboard.html";
    } catch (err) {
      showInlineError(errorEl, err instanceof Error ? err.message : "Login failed.");
    } finally {
      submitBtn.disabled = false;
      if (spinner) spinner.classList.add("hidden");
      if (submitBtn && prevText) submitBtn.innerHTML = prevText;
    }
  });

  // Social login (UI-only demo)
  document.querySelectorAll("[data-social-provider]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      showInlineError(errorEl, "");
      const provider = btn.getAttribute("data-social-provider") || "social";
      const rememberMe = Boolean(rememberEl?.checked);
      const submitBtn = $("login-submit");
      submitBtn.disabled = true;

      const spinner = $("login-spinner");
      if (spinner) spinner.classList.remove("hidden");

      try {
        await socialLogin({ provider, rememberMe });
        window.location.href = "./dashboard.html";
      } catch (err) {
        showInlineError(errorEl, err instanceof Error ? err.message : "Login failed.");
        submitBtn.disabled = false;
        if (spinner) spinner.classList.add("hidden");
      }
    });
  });
}

function initSignupPage() {
  const form = document.getElementById("signup-form");
  if (!form) return;

  if (!ensureUnauthenticated({ redirectTo: "./dashboard.html" })) return;

  const usernameEl = $("signup-username");
  const emailEl = $("signup-email");
  const passwordEl = $("signup-password");
  const confirmEl = $("signup-confirm");
  const errorEl = $("signup-error");

  const togglePassword = $("toggle-signup-password");
  const toggleConfirm = $("toggle-signup-confirm");
  if (togglePassword) {
    togglePassword.addEventListener("click", () => {
      const isHidden = passwordEl.type === "password";
      passwordEl.type = isHidden ? "text" : "password";
      togglePassword.textContent = isHidden ? "Hide" : "Show";
    });
  }
  if (toggleConfirm) {
    toggleConfirm.addEventListener("click", () => {
      const isHidden = confirmEl.type === "password";
      confirmEl.type = isHidden ? "text" : "password";
      toggleConfirm.textContent = isHidden ? "Hide" : "Show";
    });
  }

  const meterFill = $("strength-fill");
  const strengthText = $("strength-text");
  const updateMeter = () => {
    const { score, label } = computePasswordStrength(passwordEl.value);
    if (meterFill) meterFill.style.width = `${score}%`;
    if (strengthText) strengthText.textContent = label;
  };
  passwordEl?.addEventListener("input", updateMeter);
  updateMeter();

  const successModal = $("signup-success-modal");

  const modalClose = document.querySelectorAll("[data-modal-close]");
  modalClose.forEach((btn) => {
    btn.addEventListener("click", () => {
      const modal = btn.closest(".modal-overlay");
      setModalVisible(modal, false);
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showInlineError(errorEl, "");

    const username = usernameEl.value.trim();
    const email = emailEl.value.trim();
    const password = passwordEl.value;
    const confirm = confirmEl.value;

    if (!username) return showInlineError(errorEl, "Username is required.");
    if (!isValidEmail(email)) return showInlineError(errorEl, "Enter a valid email address.");
    if (!password) return showInlineError(errorEl, "Password is required.");
    if (password.length < 8) return showInlineError(errorEl, "Password must be at least 8 characters.");
    if (password !== confirm) return showInlineError(errorEl, "Passwords do not match.");

    const submitBtn = $("signup-submit");
    const spinner = $("signup-spinner");
    const prevText = submitBtn?.innerHTML || "";
    submitBtn.disabled = true;
    if (spinner) spinner.classList.remove("hidden");

    try {
      await register({ username, email, password });
      // Auto-login after signup (demo): put session in sessionStorage (no remember-me on signup).
      await login({ email, password, rememberMe: false });

      setModalVisible(successModal, true);
      setTimeout(() => {
        window.location.href = "./dashboard.html";
      }, 1400);
    } catch (err) {
      showInlineError(errorEl, err instanceof Error ? err.message : "Signup failed.");
    } finally {
      submitBtn.disabled = false;
      if (spinner) spinner.classList.add("hidden");
      if (submitBtn && prevText) submitBtn.innerHTML = prevText;
    }
  });

  // Social login on signup page (demo)
  document.querySelectorAll("[data-social-provider]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      showInlineError(errorEl, "");
      const provider = btn.getAttribute("data-social-provider") || "social";
      const submitBtn = $("signup-submit");
      submitBtn.disabled = true;

      const spinner = $("signup-spinner");
      if (spinner) spinner.classList.remove("hidden");

      try {
        await socialLogin({ provider, rememberMe: false });
        window.location.href = "./dashboard.html";
      } catch (err) {
        showInlineError(errorEl, err instanceof Error ? err.message : "Signup failed.");
        submitBtn.disabled = false;
        if (spinner) spinner.classList.add("hidden");
      }
    });
  });
}

function initDashboardPage() {
  const logoutBtn = $("logout-btn");
  const usernameEl = $("navbar-username");
  if (!logoutBtn && !usernameEl) return;

  const session = ensureAuthenticated({ redirectTo: "./login.html" });
  if (!session) return;

  if (usernameEl) usernameEl.textContent = session.username;

  logoutBtn?.addEventListener("click", () => {
    clearSession();
    window.location.href = "./login.html";
  });
}

// Auto-init based on page
function initFromPage() {
  initDarkModeToggle();
  const mode = getAuthPageMode();
  if (mode === "login") initLoginPage();
  if (mode === "signup") initSignupPage();
  if (mode === "dashboard") initDashboardPage();
}

// Kick off after DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initFromPage);
} else {
  initFromPage();
}

