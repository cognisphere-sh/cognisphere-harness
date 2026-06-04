/**
 * Server-driven OAuth login flows for subscription model providers
 * (catalog entries with `oauth: true`).
 *
 * Reuses pi-coding-agent's `AuthStorage` — the exact machinery behind
 * pi's `/login` command. Tokens persist to pi's own
 * `<agentDir>/auth.json` (default `~/.pi/agent/auth.json`, 0600,
 * file-locked), NOT to the harness's models.json. Rationale:
 *   - refresh tokens rotate on every refresh; spawned pi children
 *     already refresh + persist under a file lock, so the harness must
 *     not hold a competing copy that would go stale, and
 *   - access tokens expire mid-session; env-injected keys can't be
 *     updated on a live child, but pi re-resolves auth.json itself.
 * Spawned children inherit the server's env, so they read the same
 * auth.json with zero changes to credential injection.
 *
 * Flow shape (pi-ai's `OAuthLoginCallbacks`): `login()` starts the
 * provider flow in the background and resolves once the auth URL is
 * known. The browser opens the URL; either the provider's localhost
 * callback server completes the flow (harness on the same machine as
 * the browser), or the operator pastes the final redirect URL /
 * authorization code back via `submitInput()`. One pending login per
 * provider — the callback server binds a fixed port.
 */

import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { Logger } from "./logger.js";

export type OAuthLoginState =
  | { state: "idle" }
  | { state: "pending"; url?: string; instructions?: string }
  | { state: "success" }
  | { state: "error"; message: string };

interface PendingLogin {
  url?: string;
  instructions?: string;
  /** Resolves the outstanding onPrompt/onManualCodeInput waiter, if any. */
  submitInput?: (input: string) => void;
  rejectInput?: (err: Error) => void;
  abort: AbortController;
  /** Settles when the underlying provider flow settles (never rejects). */
  settled: Promise<void>;
}

export class OAuthLoginManager {
  private readonly pending = new Map<string, PendingLogin>();
  /** Last terminal outcome per provider; cleared on the next start(). */
  private readonly results = new Map<
    string,
    { state: "success" } | { state: "error"; message: string }
  >();

  constructor(
    private readonly log: Logger,
    private readonly onSuccess: (providerId: string) => void,
  ) {}

  /** OAuth credentials present in pi's auth.json for this provider. */
  connected(providerId: string): boolean {
    return AuthStorage.create().has(providerId);
  }

  /** Provider id is in pi-ai's OAuth registry. */
  supported(providerId: string): boolean {
    return AuthStorage.create()
      .getOAuthProviders()
      .some((p) => p.id === providerId);
  }

  status(providerId: string): OAuthLoginState {
    const p = this.pending.get(providerId);
    if (p) return { state: "pending", url: p.url, instructions: p.instructions };
    return this.results.get(providerId) ?? { state: "idle" };
  }

  /**
   * Start (or restart) a login flow. Cancels any pending flow for the
   * provider first — the provider's callback server binds a fixed port,
   * so two flows can't coexist. Resolves once the auth URL is available
   * (or the flow failed even earlier).
   */
  async start(providerId: string): Promise<OAuthLoginState> {
    await this.cancel(providerId);
    this.results.delete(providerId);

    const entry: PendingLogin = {
      abort: new AbortController(),
      settled: Promise.resolve(),
    };
    let urlReady!: () => void;
    const urlPromise = new Promise<void>((resolve) => {
      urlReady = resolve;
    });

    const auth = AuthStorage.create();
    entry.settled = auth
      .login(providerId, {
        onAuth: (info) => {
          entry.url = info.url;
          entry.instructions = info.instructions;
          urlReady();
        },
        onPrompt: () => this.waitForInput(entry),
        onManualCodeInput: () => this.waitForInput(entry),
        onProgress: (message) =>
          this.log.info({ providerId, message }, "oauth login progress"),
        signal: entry.abort.signal,
      })
      .then(() => {
        this.results.set(providerId, { state: "success" });
        this.log.info({ providerId }, "oauth login succeeded");
        this.onSuccess(providerId);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.results.set(providerId, { state: "error", message });
        this.log.warn({ providerId, err }, "oauth login failed");
      })
      .finally(() => {
        urlReady(); // unblock start() if the flow died before onAuth
        this.pending.delete(providerId);
      });
    this.pending.set(providerId, entry);

    await urlPromise;
    return this.status(providerId);
  }

  /** Feed a pasted redirect URL / authorization code into the pending flow. */
  submitInput(providerId: string, input: string): boolean {
    const entry = this.pending.get(providerId);
    if (!entry?.submitInput) return false;
    entry.submitInput(input);
    entry.submitInput = undefined;
    entry.rejectInput = undefined;
    return true;
  }

  /** Abort a pending flow (no-op if none) and wait for it to wind down. */
  async cancel(providerId: string): Promise<void> {
    const entry = this.pending.get(providerId);
    if (!entry) return;
    entry.rejectInput?.(new Error("login cancelled"));
    entry.abort.abort();
    await entry.settled;
    this.results.delete(providerId); // a cancel is not an error worth surfacing
  }

  /** Remove stored OAuth credentials from pi's auth.json. */
  logout(providerId: string): void {
    AuthStorage.create().logout(providerId);
    this.results.delete(providerId);
  }

  private waitForInput(entry: PendingLogin): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      entry.submitInput = resolve;
      entry.rejectInput = reject;
    });
  }
}
