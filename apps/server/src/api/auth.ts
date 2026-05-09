import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { ServerConfig } from "../config.js";
import { harnessRoot } from "../config.js";
import type { Logger } from "../logger.js";

/**
 * File-based static auth for v0.
 *
 * Users live at `<harnessRoot>/users.json`:
 *   { "users": [ { "username": "admin", "password": "changeme" } ] }
 *
 * Plaintext passwords — same trade-off as `secrets.json` (encryption deferred).
 * On first boot the file is auto-created with a single `admin / changeme`
 * entry that must be changed before exposing the server.
 *
 * Sessions are kept in memory: an opaque token (32 random bytes, hex-encoded)
 * is stored in the `pi_sid` cookie. Restarting the server invalidates every
 * session — sufficient for a single-user local tool.
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

interface Session {
  username: string;
  expiresAt: number;
}

export class AuthStore {
  private cache: UsersFile | null = null;
  private sessions = new Map<string, Session>();

  constructor(
    private readonly filePath: string,
    private readonly log: Logger,
  ) {}

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
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, {
      username,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return token;
  }

  resolveSession(token: string | undefined): string | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return s.username;
  }

  destroySession(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}

export function makeAuthStore(cfg: ServerConfig, log: Logger): AuthStore {
  return new AuthStore(join(harnessRoot(cfg), "users.json"), log);
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
    const token = getCookie(c, COOKIE_NAME);
    auth.destroySession(token);
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
