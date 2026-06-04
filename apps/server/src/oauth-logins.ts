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
 * provider flow in the background and resolves once the flow surfaces
 * its first interaction — an auth URL (`onAuth`), a login-method
 * selector (`onSelect`, e.g. Codex browser vs device-code), a device
 * code to display (`onDeviceCode`), or a text prompt (`onPrompt`).
 * Each is exposed via `status()` for the web UI to render; answers
 * come back through `submitInput()`. For callback-server flows, either
 * the provider's localhost callback completes the flow (harness on the
 * same machine as the browser) or the operator pastes the final
 * redirect URL. One pending login per provider — the callback server
 * binds a fixed port.
 */

import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { Logger } from "./logger.js";

export interface OAuthSelectInfo {
  message: string;
  options: { id: string; label: string }[];
}

export interface OAuthDeviceCodeDisplay {
  userCode: string;
  verificationUri: string;
}

export interface OAuthPromptInfo {
  message: string;
  placeholder?: string;
}

export type OAuthLoginState =
  | { state: "idle" }
  | {
      state: "pending";
      url?: string;
      instructions?: string;
      /** Outstanding choice (e.g. Codex: browser vs device-code login). */
      select?: OAuthSelectInfo;
      /** Device-code flow: show this code + verification URL to the operator. */
      deviceCode?: OAuthDeviceCodeDisplay;
      /** Outstanding free-text prompt beyond the default redirect-URL paste. */
      prompt?: OAuthPromptInfo;
    }
  | { state: "success" }
  | { state: "error"; message: string };

interface PendingLogin {
  url?: string;
  instructions?: string;
  select?: OAuthSelectInfo;
  deviceCode?: OAuthDeviceCodeDisplay;
  prompt?: OAuthPromptInfo;
  /** Resolves the outstanding onPrompt/onManualCodeInput text waiter, if any. */
  submitText?: (input: string) => void;
  rejectText?: (err: Error) => void;
  /** Resolves the outstanding onSelect waiter, if any (undefined = cancel). */
  submitSelect?: (optionId: string | undefined) => void;
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
    if (p) {
      return {
        state: "pending",
        url: p.url,
        instructions: p.instructions,
        select: p.select,
        deviceCode: p.deviceCode,
        prompt: p.prompt,
      };
    }
    return this.results.get(providerId) ?? { state: "idle" };
  }

  /**
   * Start (or restart) a login flow. Cancels any pending flow for the
   * provider first — the provider's callback server binds a fixed port,
   * so two flows can't coexist. Resolves once the flow surfaces its
   * first interaction (auth URL / selector / device code / prompt) or
   * fails even earlier.
   */
  async start(providerId: string): Promise<OAuthLoginState> {
    await this.cancel(providerId);
    this.results.delete(providerId);

    const entry: PendingLogin = {
      abort: new AbortController(),
      settled: Promise.resolve(),
    };
    let surfaced!: () => void;
    const surfacedPromise = new Promise<void>((resolve) => {
      surfaced = resolve;
    });

    const auth = AuthStorage.create();
    entry.settled = auth
      .login(providerId, {
        onAuth: (info) => {
          entry.url = info.url;
          entry.instructions = info.instructions;
          surfaced();
        },
        onSelect: (prompt) => {
          entry.select = {
            message: prompt.message,
            options: prompt.options.map((o) => ({ id: o.id, label: o.label })),
          };
          surfaced();
          return new Promise<string | undefined>((resolve) => {
            entry.submitSelect = (optionId) => {
              entry.select = undefined;
              entry.submitSelect = undefined;
              resolve(optionId);
            };
          });
        },
        onDeviceCode: (info) => {
          entry.deviceCode = {
            userCode: info.userCode,
            verificationUri: info.verificationUri,
          };
          surfaced();
        },
        onPrompt: (prompt) => {
          entry.prompt = {
            message: prompt.message,
            placeholder: prompt.placeholder,
          };
          surfaced();
          return this.waitForText(entry);
        },
        onManualCodeInput: () => this.waitForText(entry),
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
        surfaced(); // unblock start() if the flow died before any interaction
        this.pending.delete(providerId);
      });
    this.pending.set(providerId, entry);

    await surfacedPromise;
    return this.status(providerId);
  }

  /**
   * Feed operator input into the pending flow. `kind: "select"` answers
   * an outstanding selector with an option id; `kind: "text"` (default)
   * answers a prompt / pastes a redirect URL or authorization code.
   */
  submitInput(
    providerId: string,
    input: string,
    kind: "text" | "select" = "text",
  ): boolean {
    const entry = this.pending.get(providerId);
    if (!entry) return false;
    if (kind === "select") {
      if (!entry.submitSelect) return false;
      entry.submitSelect(input);
      return true;
    }
    if (!entry.submitText) return false;
    entry.prompt = undefined;
    entry.submitText(input);
    entry.submitText = undefined;
    entry.rejectText = undefined;
    return true;
  }

  /** Abort a pending flow (no-op if none) and wait for it to wind down. */
  async cancel(providerId: string): Promise<void> {
    const entry = this.pending.get(providerId);
    if (!entry) return;
    entry.submitSelect?.(undefined); // provider treats undefined as cancel
    entry.rejectText?.(new Error("login cancelled"));
    entry.abort.abort();
    await entry.settled;
    this.results.delete(providerId); // a cancel is not an error worth surfacing
  }

  /** Remove stored OAuth credentials from pi's auth.json. */
  logout(providerId: string): void {
    AuthStorage.create().logout(providerId);
    this.results.delete(providerId);
  }

  private waitForText(entry: PendingLogin): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      entry.submitText = resolve;
      entry.rejectText = reject;
    });
  }
}
