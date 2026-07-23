/**
 * Server-driven OAuth login flows for subscription model providers
 * (catalog entries with `oauth: true`).
 *
 * Reuses pi-coding-agent's `ModelRuntime` — the exact machinery behind
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
 * Flow shape (pi-ai's `AuthInteraction`): `login()` starts the provider
 * flow in the background and resolves once the flow surfaces its first
 * interaction — an auth URL or device code (`notify`), or a prompt
 * (`prompt`: a login-method selector, a free-text question, or the
 * manual redirect-URL/code paste raced against the provider's callback
 * server). Each is exposed via `status()` for the web UI to render;
 * answers come back through `submitInput()`. A prompt may carry its own
 * `AbortSignal` (e.g. the manual-code paste is cancelled when the
 * callback server wins the race) — aborting clears the pending UI
 * state. For callback-server flows, either the provider's localhost
 * callback completes the flow (harness on the same machine as the
 * browser) or the operator pastes the final redirect URL. One pending
 * login per provider — the callback server binds a fixed port.
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthPrompt } from "@earendil-works/pi-ai";
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
  /** Resolves the outstanding text/manual-code prompt waiter, if any. */
  submitText?: (input: string) => void;
  rejectText?: (err: Error) => void;
  /** Resolves the outstanding select waiter, if any (undefined = cancel). */
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
  private runtimePromise?: Promise<ModelRuntime>;

  constructor(
    private readonly log: Logger,
    private readonly onSuccess: (providerId: string) => void,
  ) {}

  /**
   * Shared pi model runtime, created on first use. Owns login/logout
   * orchestration; credentials go to pi's default auth.json.
   */
  private runtime(): Promise<ModelRuntime> {
    this.runtimePromise ??= ModelRuntime.create();
    return this.runtimePromise;
  }

  /** Provider has an OAuth login flow in pi-ai's registry. */
  async supported(providerId: string): Promise<boolean> {
    const runtime = await this.runtime();
    return runtime.getProvider(providerId)?.auth.oauth !== undefined;
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

    const runtime = await this.runtime();
    entry.settled = runtime
      .login(providerId, "oauth", {
        signal: entry.abort.signal,
        notify: (event) => {
          switch (event.type) {
            case "auth_url":
              entry.url = event.url;
              entry.instructions = event.instructions;
              surfaced();
              break;
            case "device_code":
              entry.deviceCode = {
                userCode: event.userCode,
                verificationUri: event.verificationUri,
              };
              surfaced();
              break;
            case "info":
            case "progress":
              this.log.info(
                { providerId, message: event.message },
                "oauth login progress",
              );
              break;
          }
        },
        prompt: (prompt) => this.handlePrompt(entry, prompt, surfaced),
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
   * Answer one `AuthInteraction.prompt()`. Selects surface as a chooser;
   * text/secret prompts surface as a question; `manual_code` reuses the
   * default redirect-URL paste field, so no extra prompt UI is shown.
   * Rejects on cancel or when the prompt's own signal aborts.
   */
  private handlePrompt(
    entry: PendingLogin,
    prompt: AuthPrompt,
    surfaced: () => void,
  ): Promise<string> {
    if (prompt.type === "select") {
      entry.select = {
        message: prompt.message,
        options: prompt.options.map((o) => ({ id: o.id, label: o.label })),
      };
      surfaced();
      return new Promise<string>((resolve, reject) => {
        entry.submitSelect = (optionId) => {
          entry.select = undefined;
          entry.submitSelect = undefined;
          if (optionId === undefined) reject(new Error("login cancelled"));
          else resolve(optionId);
        };
        prompt.signal?.addEventListener(
          "abort",
          () => entry.submitSelect?.(undefined),
          { once: true },
        );
      });
    }
    if (prompt.type !== "manual_code") {
      entry.prompt = {
        message: prompt.message,
        placeholder: prompt.placeholder,
      };
    }
    surfaced();
    return this.waitForText(entry, prompt.signal);
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
    entry.submitSelect?.(undefined); // rejects the select waiter as cancelled
    entry.rejectText?.(new Error("login cancelled"));
    entry.abort.abort();
    await entry.settled;
    this.results.delete(providerId); // a cancel is not an error worth surfacing
  }

  /** Remove stored OAuth credentials from pi's auth.json. */
  async logout(providerId: string): Promise<void> {
    const runtime = await this.runtime();
    await runtime.logout(providerId);
    this.results.delete(providerId);
  }

  private waitForText(
    entry: PendingLogin,
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      entry.submitText = resolve;
      entry.rejectText = reject;
      // e.g. manual-code paste raced against the provider's callback
      // server: when the callback wins, pi aborts the prompt — clear the
      // waiter so stale input can't leak into a later prompt.
      signal?.addEventListener(
        "abort",
        () => {
          if (entry.rejectText !== reject) return; // superseded
          entry.prompt = undefined;
          entry.submitText = undefined;
          entry.rejectText = undefined;
          reject(new Error("prompt aborted"));
        },
        { once: true },
      );
    });
  }
}
