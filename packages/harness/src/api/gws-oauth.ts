import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentManager } from "../core/agent-manager.js";
import type { ServerConfig } from "../core/config.js";
import { agentDir, secretsRoot } from "../core/config.js";
import type { Logger } from "../core/logger.js";
import { MASK, maskCredential } from "./credentials.js";
import { readSecrets, setSecretValue } from "./secrets.js";

/**
 * /api/gws/oauth — browser-driven Google sign-in/sign-out for agents with
 * the `gws` plugin, replacing the manual `gws auth login` + `gws auth
 * export` dance.
 *
 *   GET    /                  → { client, agents } — OAuth client (masked) + per-agent status
 *   PUT    /client            → save the operator's Google OAuth client id/secret
 *   POST   /:agentId/start    → { url } — Google consent URL; browser navigates there
 *   GET    /callback          → Google redirects here; exchanges the code,
 *                               writes the credentials file, sets the agent's
 *                               gws secret, reloads the agent, → /settings
 *   DELETE /:agentId          → sign out: revoke token, delete file, clear secret
 *
 * The operator creates a "Web application" OAuth client in their own GCP
 * project (with the Gmail API enabled) and registers
 * `<console origin>/api/gws/oauth/callback` as a redirect URI; the client
 * id/secret are stored once per harness in `.secrets/gws/oauth-client.json`
 * and shared by every agent. Sign-in writes the standard Google
 * `authorized_user` JSON — the exact shape `gws auth export --unmasked`
 * produces — to `.secrets/gws/<agentId>/credentials.json` and points the
 * agent's `gws.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` secret at it.
 *
 * The callback is under authenticated /api: the Google redirect is a
 * top-level GET navigation, so the SameSite=Lax session cookie rides along.
 */

const PLUGIN_ID = "gws";
const SECRET_KEY = "GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
// Always requested: gmail.modify covers everything the gws plugin and its
// seed scripts do (read, send, mark-read); openid+email label the account.
// Extra scopes (calendar, drive, …) are picked in the Settings card and
// arrive via the start route's `scopes` body field.
const BASE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
];
const PENDING_TTL_MS = 10 * 60 * 1000;

interface OauthClient {
  clientId: string;
  clientSecret: string;
}

interface PendingSignIn {
  agentId: string;
  redirectUri: string;
  expiresAt: number;
}

export function gwsOauthRouter(
  am: AgentManager,
  cfg: ServerConfig,
  log: Logger,
): Hono {
  const r = new Hono();
  const gwsDir = join(secretsRoot(cfg), "gws");
  const clientPath = join(gwsDir, "oauth-client.json");
  const secretsPath = join(secretsRoot(cfg), "secrets.json");
  const credsPath = (agentId: string) =>
    join(gwsDir, agentId, "credentials.json");
  const accountPath = (agentId: string) => join(gwsDir, agentId, "account.json");
  /** nonce → pending sign-in; single-process, so in-memory is enough. */
  const pending = new Map<string, PendingSignIn>();

  const readClient = (): OauthClient => {
    try {
      const parsed = JSON.parse(readFileSync(clientPath, "utf8")) as OauthClient;
      return {
        clientId: parsed.clientId ?? "",
        clientSecret: parsed.clientSecret ?? "",
      };
    } catch {
      return { clientId: "", clientSecret: "" };
    }
  };

  const gwsAgents = () =>
    am.list().filter((a) => a.installedPlugins.includes(PLUGIN_ID));

  r.get("/", (c) => {
    const client = readClient();
    const secrets = readSecrets(secretsPath);
    const agents = gwsAgents().map((a) => {
      const secretValue = secrets[a.id]?.[PLUGIN_ID]?.[SECRET_KEY] ?? "";
      const managed = secretValue === credsPath(a.id);
      let email: string | null = null;
      let scopes: string[] = [];
      if (managed) {
        try {
          const account = JSON.parse(
            readFileSync(accountPath(a.id), "utf8"),
          ) as { email?: string; scopes?: string[] };
          email = account.email ?? null;
          scopes = account.scopes ?? [];
        } catch {
          // account.json is display-only; absence is fine
        }
      }
      return {
        agentId: a.id,
        name: a.name,
        signedIn: secretValue.length > 0,
        managed,
        email,
        scopes,
      };
    });
    return c.json({
      client: {
        clientId: client.clientId,
        clientSecret: maskCredential(client.clientSecret, true),
      },
      agents,
      mask: MASK,
    });
  });

  r.put("/client", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      clientId?: string;
      clientSecret?: string;
    } | null;
    if (!body || typeof body.clientId !== "string") {
      return c.json({ error: "expected { clientId, clientSecret }" }, 400);
    }
    const existing = readClient();
    const clientSecret =
      body.clientSecret === MASK || body.clientSecret === undefined
        ? existing.clientSecret
        : body.clientSecret;
    mkdirSync(gwsDir, { recursive: true });
    writeFileSync(
      clientPath,
      JSON.stringify({ clientId: body.clientId.trim(), clientSecret }, null, 2) +
        "\n",
      { mode: 0o600 },
    );
    return c.json({ ok: true });
  });

  r.post("/:agentId/start", async (c) => {
    const agentId = c.req.param("agentId");
    if (!gwsAgents().some((a) => a.id === agentId)) {
      return c.json({ error: `agent '${agentId}' has no gws plugin` }, 404);
    }
    const body = (await c.req.json().catch(() => null)) as {
      redirectUri?: string;
    } | null;
    if (!body?.redirectUri) {
      return c.json({ error: "expected { redirectUri }" }, 400);
    }
    // Extra scopes come from the agent's gws plugin config (`oauthScopes`,
    // comma-separated) — a developer decision, not a sign-in-time one.
    const scope = [
      ...new Set([...BASE_SCOPES, ...configuredScopes(am, cfg, agentId)]),
    ].join(" ");
    const client = readClient();
    if (!client.clientId || !client.clientSecret) {
      return c.json(
        { error: "Google OAuth client not configured — save a client id and secret first" },
        409,
      );
    }
    const nonce = randomBytes(16).toString("hex");
    const now = Date.now();
    for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
    pending.set(nonce, {
      agentId,
      redirectUri: body.redirectUri,
      expiresAt: now + PENDING_TTL_MS,
    });
    const url =
      `${AUTH_URL}?` +
      new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: body.redirectUri,
        response_type: "code",
        scope,
        // offline + consent → Google always returns a refresh_token
        access_type: "offline",
        prompt: "consent",
        state: nonce,
      }).toString();
    return c.json({ url });
  });

  r.get("/callback", async (c) => {
    const fail = (msg: string) => {
      log.warn({ msg }, "gws oauth sign-in failed");
      return c.redirect(`/settings?gwsError=${encodeURIComponent(msg)}`);
    };
    const state = c.req.query("state") ?? "";
    const entry = pending.get(state);
    pending.delete(state);
    if (!entry || entry.expiresAt < Date.now()) {
      return fail("sign-in expired or unknown — start again from Settings");
    }
    const oauthError = c.req.query("error");
    if (oauthError) return fail(`Google returned: ${oauthError}`);
    const code = c.req.query("code");
    if (!code) return fail("Google returned no authorization code");

    const client = readClient();
    let tok: {
      refresh_token?: string;
      id_token?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };
    try {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          redirect_uri: entry.redirectUri,
          grant_type: "authorization_code",
        }),
      });
      tok = (await res.json()) as typeof tok;
    } catch (err) {
      return fail(`token exchange failed: ${(err as Error).message}`);
    }
    if (tok.error || !tok.refresh_token) {
      return fail(
        `token exchange failed: ${tok.error_description ?? tok.error ?? "no refresh token in response"}`,
      );
    }

    // The exact shape `gws auth export --unmasked` produces — what the gws
    // CLI accepts via GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE.
    const credentials = {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: tok.refresh_token,
      type: "authorized_user",
    };
    const path = credsPath(entry.agentId);
    mkdirSync(join(gwsDir, entry.agentId), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(credentials, null, 2) + "\n", {
      mode: 0o600,
    });
    const email = emailFromIdToken(tok.id_token);
    // `scope` in the token response is what Google actually granted (the
    // consent screen lets the user untick scopes).
    const scopes = (tok.scope ?? "").split(" ").filter(Boolean);
    writeFileSync(
      accountPath(entry.agentId),
      JSON.stringify(
        { email, scopes, signedInAt: new Date().toISOString() },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );

    setSecretValue(secretsPath, entry.agentId, PLUGIN_ID, SECRET_KEY, path);
    await am.reloadAgent(entry.agentId);
    log.info({ agentId: entry.agentId, email }, "gws oauth sign-in complete");
    return c.redirect("/settings?gws=signed-in");
  });

  r.delete("/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    if (!gwsAgents().some((a) => a.id === agentId)) {
      return c.json({ error: `agent '${agentId}' has no gws plugin` }, 404);
    }
    const path = credsPath(agentId);
    if (existsSync(path)) {
      try {
        const { refresh_token } = JSON.parse(readFileSync(path, "utf8")) as {
          refresh_token?: string;
        };
        if (refresh_token) {
          await fetch(`${REVOKE_URL}?token=${encodeURIComponent(refresh_token)}`, {
            method: "POST",
          });
        }
      } catch (err) {
        // best-effort: the grant can also be revoked at myaccount.google.com
        log.warn({ err, agentId }, "gws token revocation failed");
      }
      rmSync(join(gwsDir, agentId), { recursive: true, force: true });
    }
    setSecretValue(secretsPath, agentId, PLUGIN_ID, SECRET_KEY, null);
    await am.reloadAgent(agentId);
    log.info({ agentId }, "gws oauth signed out");
    return c.json({ ok: true });
  });

  return r;
}

/** The agent's `gws` plugin config `oauthScopes` (comma-separated), from
 *  the live plugin entry when the plugin loaded, else from config.json on
 *  disk (so a plugin that failed to start — e.g. not signed in yet — still
 *  gets its configured scopes). */
function configuredScopes(
  am: AgentManager,
  cfg: ServerConfig,
  agentId: string,
): string[] {
  let config = am.get(agentId)?.plugins.get(PLUGIN_ID)?.config as
    | { oauthScopes?: string }
    | null
    | undefined;
  if (config == null) {
    try {
      config = JSON.parse(
        readFileSync(
          join(agentDir(cfg, agentId), "plugins", PLUGIN_ID, "config.json"),
          "utf8",
        ),
      ) as { oauthScopes?: string };
    } catch {
      return [];
    }
  }
  return (config.oauthScopes ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Best-effort email claim from Google's id_token. No signature check —
 *  the token just arrived over TLS from Google's own token endpoint, and
 *  the value is display-only. */
function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { email?: string };
    return payload.email ?? null;
  } catch {
    return null;
  }
}
