import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSetting, setSetting } from "./db.js";

const COOKIE = "portal_session";
const MAX_AGE_DAYS = 30;
let secret;

export async function initAuth() {
  secret = process.env.SESSION_SECRET || (await getSetting("session_secret"));
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    await setSetting("session_secret", secret);
  }
  if (!process.env.PORTAL_PASSWORD) console.warn("PORTAL_PASSWORD is not set; nobody can sign in.");
}

const sign = (payload) => createHmac("sha256", secret).update(payload).digest("base64url");
const sameHash = (a, b) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

function readCookie(req) {
  const match = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  return match ? decodeURIComponent(match.slice(COOKIE.length + 1)) : null;
}

export function isSignedIn(req) {
  const token = readCookie(req);
  if (!token) return false;
  const [expires, sig] = token.split(".");
  return !!sig && sameHash(sig, sign(expires)) && Number(expires) > Date.now();
}

function setCookie(res, value, maxAgeSec) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}

// Simple brute-force brake: 10 failed attempts per IP per 15 minutes.
const failures = new Map();

export function login(req, res) {
  const ip = req.ip;
  const now = Date.now();
  const recent = (failures.get(ip) || []).filter((t) => now - t < 15 * 60_000);
  if (recent.length >= 10) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });

  const expected = process.env.PORTAL_PASSWORD;
  if (!expected || typeof req.body?.password !== "string" || !sameHash(req.body.password, expected)) {
    failures.set(ip, [...recent, now]);
    return res.status(401).json({ error: "Wrong password." });
  }
  failures.delete(ip);
  const expires = String(now + MAX_AGE_DAYS * 86_400_000);
  setCookie(res, `${expires}.${sign(expires)}`, MAX_AGE_DAYS * 86_400);
  res.json({ ok: true });
}

export function logout(_req, res) {
  setCookie(res, "", 0);
  res.json({ ok: true });
}

export function requireAuth(req, res, next) {
  if (isSignedIn(req)) return next();
  res.status(401).json({ error: "Not signed in." });
}
