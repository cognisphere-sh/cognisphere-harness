import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createInterface, type Interface } from "node:readline/promises";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { ServerConfig } from "../core/config.js";
import { secretsRoot } from "../core/config.js";
import type { Logger } from "../core/logger.js";

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
 *
 * App-to-harness auth: a frontend app that owns its own user auth (Clerk,
 * Supabase, …) authenticates its *server* to the harness with the shared
 * secret at `<harnessRoot>/.secrets/app-secret` (hex, generated on first
 * boot) as `Authorization: Bearer <secret>`, and asserts the acting user
 * with `X-App-User: <opaque id>` (defaults to "app"). The header is trusted
 * only alongside a valid bearer. Rotate by deleting the file and restarting.
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
  private readonly appSecret: string;

  constructor(
    private readonly filePath: string,
    private readonly keyPath: string,
    private readonly appSecretPath: string,
    private readonly log: Logger,
  ) {
    this.secret = this.loadOrCreateKey();
    this.appSecret = this.loadOrCreateAppSecret();
  }

  private loadOrCreateAppSecret(): string {
    if (existsSync(this.appSecretPath)) {
      const s = readFileSync(this.appSecretPath, "utf8").trim();
      if (s.length < 32) {
        throw new Error(
          `app secret ${this.appSecretPath} is too short (${s.length} chars); expected at least 32`,
        );
      }
      return s;
    }
    mkdirSync(dirname(this.appSecretPath), { recursive: true });
    const s = randomBytes(24).toString("hex");
    writeFileSync(this.appSecretPath, s + "\n", { mode: 0o600 });
    this.log.info({ path: this.appSecretPath }, "auth: generated new app secret");
    return s;
  }

  /** Resolve the acting user from a request: session cookie, else app bearer. */
  resolveRequest(c: Context): string | null {
    const fromCookie = this.resolveSession(getCookie(c, COOKIE_NAME));
    if (fromCookie) return fromCookie;
    const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!bearer) return null;
    const a = Buffer.from(bearer, "utf8");
    const b = Buffer.from(this.appSecret, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return c.req.header("x-app-user")?.trim() || "app";
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
  return new AuthStore(
    join(root, "users.json"),
    join(root, "session-key"),
    join(root, "app-secret"),
    log,
  );
}

/**
 * On startup, ensure real login credentials exist before the server comes up.
 * If users.json is missing, empty, or still holds the default admin/changeme
 * placeholder, prompt for a username and password on the terminal and write
 * them. No-op when stdin isn't a TTY (e.g. under systemd) — there the
 * AuthStore placeholder path still applies, so the server can still boot.
 */
export async function ensureCredentials(
  cfg: ServerConfig,
  log: Logger,
): Promise<void> {
  const path = join(secretsRoot(cfg), "users.json");
  if (hasRealCredentials(path)) return;
  if (!process.stdin.isTTY) {
    log.warn(
      { path },
      "auth: no credentials and no TTY to prompt — falling back to default admin/changeme; change it before exposing the server",
    );
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("\nNo login credentials found. Create an admin user:\n");
    let username = "";
    while (!username) username = (await rl.question("  Username: ")).trim();
    let password = "";
    while (!password) password = await readHidden(rl, "  Password: ");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ users: [{ username, password }] }, null, 2) + "\n",
      { mode: 0o600 },
    );
    log.info({ path, username }, "auth: created users.json from shell prompt");
  } finally {
    rl.close();
  }
}

function hasRealCredentials(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as UsersFile;
    const users = parsed?.users;
    if (!Array.isArray(users)) return false;
    return users.some(
      (u) =>
        Boolean(u?.username) &&
        Boolean(u?.password) &&
        !(u.username === "admin" && u.password === "changeme"),
    );
  } catch {
    return false;
  }
}

// ponytail: mute echo by silencing stdout while readline reads the line, so
// the typed password isn't shown. Restore on the next tick.
async function readHidden(rl: Interface, query: string): Promise<string> {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write(query);
  process.stdout.write = () => true;
  try {
    const answer = await rl.question("");
    return answer.trim();
  } finally {
    process.stdout.write = orig;
    process.stdout.write("\n");
  }
}

export function requireAuth(auth: AuthStore): MiddlewareHandler {
  return async (c, next) => {
    const user = auth.resolveRequest(c);
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
    const user = auth.resolveRequest(c);
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
