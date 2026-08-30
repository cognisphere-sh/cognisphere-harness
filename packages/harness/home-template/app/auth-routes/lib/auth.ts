import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * App-owned auth. Default provider: the single username/password from
 * `../config` (APP_USER/APP_PASS, written to app/.env.local by
 * `scripts/server.sh secrets`) and an app-minted signed cookie — independent
 * of the harness console's `pi_sid`.
 *
 * To switch providers (Clerk, Supabase Auth, NextAuth, …) replace `getUser`
 * — it is the only function the rest of the app calls — and delete the
 * login/logout routes + page. Keep returning an opaque user id/string; it is
 * forwarded to the harness as `X-App-User` (see lib/harness.ts).
 */

export const COOKIE = "app_sid";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function secret(): string {
  const s = process.env.APP_SESSION_SECRET;
  if (!s) throw new Error("APP_SESSION_SECRET is not set");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function eq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Default provider: check the configured credentials; null if wrong. */
export function verifyCredentials(username: string, password: string): string | null {
  const u = process.env.APP_USER, p = process.env.APP_PASS;
  if (!u || !p) return null;
  return eq(username, u) && eq(password, p) ? u : null;
}

export function createSession(user: string): string {
  const payload = Buffer.from(`${user}|${Date.now() + TTL_MS}`).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Resolve the signed-in user from a Request; null when anonymous. */
export async function getUser(req: Request): Promise<string | null> {
  const token = req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))?.[1];
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  if (!eq(token.slice(dot + 1), sign(payload))) return null;
  const decoded = Buffer.from(payload, "base64url").toString();
  const pipe = decoded.lastIndexOf("|");
  if (pipe <= 0 || Number(decoded.slice(pipe + 1)) < Date.now()) return null;
  return decoded.slice(0, pipe);
}

export function sessionCookie(token: string | null): string {
  const base = `${COOKIE}=${token ?? ""}; Path=/; HttpOnly; SameSite=Lax`;
  return token ? `${base}; Max-Age=${TTL_MS / 1000}` : `${base}; Max-Age=0`;
}
