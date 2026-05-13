import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { ServerConfig } from "../config.js";
import { secretsRoot } from "../config.js";
import type { Logger } from "../logger.js";

/**
 * File-based static auth for v0.
 *
 * Users live at `<harnessRoot>/.secrets/users.json`:
 *   { "users": [ { "username": "admin", "password": "changeme" } ] }
 *
 * Plaintext passwords — same trade-off as `secrets.json` (encryption deferred).
 * On first boot the file is auto-created with a single `admin / changeme`
 * entry that must be changed before exposing the server.
 *
 * Sessions are stateless signed cookies: `<payload>.<sig>` where
 * payload = base64url("<username>|<expiresAt>") and sig = base64url(
 * hmac-sha256(secret, payload)). The 32-byte secret is persisted to
 * `<harnessRoot>/.secrets/session-key` on first boot, so sessions survive
 * restarts. Logout just clears the cookie; there is no server-side
 * revocation list — deleting `session-key` invalidates every session.
 */

interface User {
  username: string;
  password: string;
}

interface UsersFile {
  users: User[];
}

const PLACEHOLDER: UsersFile = {
  users: [{ username: "admin", password: "changeme" }],
};

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = "pi_sid";

export class AuthStore {
  private cache: UsersFile | null = null;
  private readonly secret: Buffer;

  constructor(
    private readonly filePath: string,
    private readonly keyPath: string,
    private readonly log: Logger,
  ) {
    this.secret = this.loadOrCreateKey();
  }

  private loadOrCreateKey(): Buffer {
    if (existsSync(this.keyPath)) {
      const key = readFileSync(this.keyPath);
      if (key.length < 32) {
        throw new Error(
          `session key ${this.keyPath} is too short (${key.length} bytes); expected at least 32`,
        );
      }
      return key;
    }
    mkdirSync(dirname(this.keyPath), { recursive: true });
    const key = randomBytes(32);
    writeFileSync(this.keyPath, key, { mode: 0o600 });
    this.log.info(
      { path: this.keyPath },
      "auth: generated new session-signing key",
    );
    return key;
  }

  private load(): UsersFile {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(
        this.filePath,
        JSON.stringify(PLACEHOLDER, null, 2) + "\n",
        { mode: 0o600 },
      );
      this.log.warn(
        { path: this.filePath },
        "auth: created users.json with default admin/changeme — change it before exposing the server",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (err) {
      throw new Error(
        `users file ${this.filePath} is not valid JSON: ${(err as Error).message}`,
      );
    }
    const users = (parsed as UsersFile)?.users;
    if (!Array.isArray(users)) {
      throw new Error(`users file ${this.filePath} must have a "users" array`);
    }
    this.cache = { users };
    return this.cache;
  }

  verify(username: string, password: string): boolean {
    const file = this.load();
    const user = file.users.find((u) => u.username === username);
    if (!user) return false;
    const a = Buffer.from(user.password, "utf8");
    const b = Buffer.from(password, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  createSession(username: string): string {
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const payload = Buffer.from(`${username}|${expiresAt}`, "utf8").toString(
      "base64url",
    );
    return `${payload}.${this.sign(payload)}`;
  }

  resolveSession(token: string | undefined): string | null {
    if (!token) return null;
    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = this.sign(payload);
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
    // lastIndexOf so usernames containing "|" still parse — expiresAt is
    // always the trailing field.
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const pipe = decoded.lastIndexOf("|");
    if (pipe <= 0) return null;
    const username = decoded.slice(0, pipe);
    const expiresAt = Number(decoded.slice(pipe + 1));
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
    return username;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret)
      .update(payload)
      .digest("base64url");
  }
}

export function makeAuthStore(cfg: ServerConfig, log: Logger): AuthStore {
  const root = secretsRoot(cfg);
  return new AuthStore(join(root, "users.json"), join(root, "session-key"), log);
}

export function requireAuth(auth: AuthStore): MiddlewareHandler {
  return async (c, next) => {
    const token = getCookie(c, COOKIE_NAME);
    const user = auth.resolveSession(token);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    c.set("user", user);
    await next();
  };
}

/**
 * For HTML page routes: bounce unauthenticated requests to `/login`
 * instead of returning a 401, so a fresh browser tab lands on the
 * login form rather than the SPA shell.
 */
export function redirectIfUnauthenticated(
  auth: AuthStore,
): MiddlewareHandler {
  return async (c, next) => {
    const token = getCookie(c, COOKIE_NAME);
    const user = auth.resolveSession(token);
    if (!user) return c.redirect("/login");
    c.set("user", user);
    await next();
  };
}

export function authRouter(auth: AuthStore): Hono {
  const r = new Hono();

  r.post("/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      password?: string;
    };
    if (!body.username || !body.password) {
      return c.json({ error: "username and password required" }, 400);
    }
    if (!auth.verify(body.username, body.password)) {
      return c.json({ error: "invalid credentials" }, 401);
    }
    const token = auth.createSession(body.username);
    writeSessionCookie(c, token);
    return c.json({ ok: true, username: body.username });
  });

  r.post("/logout", (c) => {
    deleteCookie(c, COOKIE_NAME, { path: "/" });
    return c.json({ ok: true });
  });

  r.get("/me", (c) => {
    const token = getCookie(c, COOKIE_NAME);
    const user = auth.resolveSession(token);
    if (!user) return c.json({ user: null }, 200);
    return c.json({ user });
  });

  return r;
}

function writeSessionCookie(c: Context, token: string): void {
  setCookie(c, COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}
