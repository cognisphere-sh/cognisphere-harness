import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Logger } from "./logger.js";

interface RpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

interface ExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  /** Present on fire-and-forget `setStatus` requests (the harness-bridge
   *  extension uses these to report session entry ids — see {@link onHarnessEntry}). */
  statusKey?: string;
  statusText?: string;
}

/**
 * Minimal shape of an entry in `agent_end.messages` / `message_start.message`.
 * The harness only inspects the final message's `role` and (for assistants)
 * `stopReason` / `errorMessage` to decide turn completion; the full pi message
 * type isn't needed here.
 */
export interface PiMessage {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
}

/** Reported by the harness-bridge extension via `setStatus("pi-harness", …)`. */
export interface HarnessEntryReport {
  kind: "user_entry";
  index: number;
  entryId: string;
}

type RpcMessage =
  | RpcResponse
  | ExtensionUiRequest
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: PiMessage[] }
  | { type: "message_start"; message?: PiMessage }
  | { type: string; [k: string]: unknown };

/**
 * One-shot wrapper around a `pi --mode rpc` child. JSONL framing, manual
 * `\n` split (readline would split on U+2028/U+2029 inside JSON strings).
 */
export class PiRpcClient {
  private readonly child: ChildProcess;
  private readonly log: Logger;
  private readonly decoder = new StringDecoder("utf8");
  private stdoutBuf = "";
  private stderrBuf = "";
  private pending = new Map<
    string,
    { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;
  private agentEndHandler: ((messages: PiMessage[]) => void) | undefined;
  private userMessageStartHandler: (() => void) | undefined;
  private harnessEntryHandler: ((report: HarnessEntryReport) => void) | undefined;
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(child: ChildProcess, log: Logger) {
    this.child = child;
    this.log = log;
    if (!child.stdout || !child.stdin) {
      throw new Error("PiRpcClient: child must have piped stdin/stdout");
    }
    child.stdout.on("data", (c: Buffer | string) => this.onStdout(c));
    child.stdout.on("end", () => this.flushStdout());
    child.stderr?.on("data", (c: Buffer | string) => {
      const s = typeof c === "string" ? c : c.toString("utf8");
      this.stderrBuf += s;
      if (this.stderrBuf.length > 16 * 1024) {
        this.stderrBuf = this.stderrBuf.slice(-16 * 1024);
      }
      this.log.debug({ stderr: s.trimEnd() }, "pi stderr");
    });
    child.on("error", (err) => {
      this.log.error({ err }, "pi child error");
      this.failPending(err);
    });
    this.exitPromise = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        this.log.debug({ code, signal }, "pi child close");
        this.failPending(
          new Error(`pi exited (code=${code} signal=${signal})`),
        );
        resolve({ code, signal });
      });
    });
  }

  /** Fires once per run when pi's agent loop ends. Receives the run's
   *  messages so the caller can inspect the final message's shape (role +
   *  stopReason) to decide whether the turn completed. */
  onAgentEnd(h: (messages: PiMessage[]) => void): void {
    this.agentEndHandler = h;
  }

  /** Fires each time pi appends a *user* message (the initial prompt and each
   *  steer). The caller counts these in dispatch order to know which rows
   *  actually reached the model. */
  onUserMessageStart(h: () => void): void {
    this.userMessageStartHandler = h;
  }

  /** Fires when the harness-bridge extension reports a user-message session
   *  entry id over the `setStatus("pi-harness", …)` channel. */
  onHarnessEntry(h: (report: HarnessEntryReport) => void): void {
    this.harnessEntryHandler = h;
  }

  waitExit() {
    return this.exitPromise;
  }

  stderrSnapshot(): string {
    return this.stderrBuf;
  }

  async sendPrompt(text: string): Promise<void> {
    const id = `p${this.nextId++}`;
    const r = await this.writeAndAwait(id, { id, type: "prompt", message: text });
    if (!r.success) throw new Error(`pi rejected prompt: ${r.error ?? "unknown"}`);
  }

  sendSteer(text: string): void {
    const id = `s${this.nextId++}`;
    this.writeFrame({ id, type: "steer", message: text });
  }

  sendAbort(): void {
    try {
      this.writeFrame({ type: "abort" });
    } catch {
      /* child may be gone */
    }
    this.endStdin();
  }

  endStdin(): void {
    const sin = this.child.stdin;
    if (!sin || sin.destroyed || sin.writableEnded) return;
    try {
      sin.end();
    } catch (err) {
      this.log.debug({ err }, "stdin.end threw");
    }
  }

  kill(sig: NodeJS.Signals = "SIGTERM"): void {
    try {
      this.child.kill(sig);
    } catch (err) {
      this.log.debug({ err, sig }, "kill threw");
    }
  }

  private writeFrame(obj: unknown): void {
    const sin = this.child.stdin;
    if (!sin || sin.destroyed || sin.writableEnded) {
      throw Object.assign(new Error("pi stdin not writable (EPIPE)"), { code: "EPIPE" });
    }
    sin.write(`${JSON.stringify(obj)}\n`);
  }

  private writeAndAwait(id: string, frame: unknown): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.writeFrame(frame);
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  private onStdout(c: Buffer | string): void {
    this.stdoutBuf += typeof c === "string" ? c : this.decoder.write(c);
    this.drain();
  }

  private flushStdout(): void {
    this.stdoutBuf += this.decoder.end();
    this.drain();
  }

  private drain(): void {
    while (true) {
      const idx = this.stdoutBuf.indexOf("\n");
      if (idx === -1) return;
      let line = this.stdoutBuf.slice(0, idx);
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let p: RpcMessage;
    try {
      p = JSON.parse(line) as RpcMessage;
    } catch {
      this.log.warn({ snippet: line.slice(0, 200) }, "non-JSON line ignored");
      return;
    }
    if (p.type === "response") {
      const r = p as RpcResponse;
      if (r.id && this.pending.has(r.id)) {
        const w = this.pending.get(r.id)!;
        this.pending.delete(r.id);
        w.resolve(r);
      }
      return;
    }
    if (p.type === "agent_end") {
      const messages = Array.isArray((p as { messages?: PiMessage[] }).messages)
        ? (p as { messages: PiMessage[] }).messages
        : [];
      this.agentEndHandler?.(messages);
      return;
    }
    if (p.type === "message_start") {
      const role = (p as { message?: PiMessage }).message?.role;
      if (role === "user") this.userMessageStartHandler?.();
      return;
    }
    if (p.type === "extension_ui_request") {
      this.handleExtensionUi(p as ExtensionUiRequest);
      return;
    }
  }

  private handleExtensionUi(req: ExtensionUiRequest): void {
    // The harness-bridge extension reports session entry ids as a
    // fire-and-forget `setStatus` keyed "pi-harness". Intercept those and
    // route to the harness-entry handler instead of treating them as UI.
    if (req.method === "setStatus" && req.statusKey === "pi-harness") {
      if (req.statusText == null) return;
      try {
        const report = JSON.parse(req.statusText) as HarnessEntryReport;
        if (
          report.kind === "user_entry" &&
          typeof report.index === "number" &&
          typeof report.entryId === "string"
        ) {
          this.harnessEntryHandler?.(report);
        }
      } catch {
        this.log.debug({ statusText: req.statusText }, "bad pi-harness setStatus payload");
      }
      return;
    }
    const dialog = new Set(["select", "confirm", "input", "editor"]);
    if (dialog.has(req.method)) {
      this.log.warn({ method: req.method }, "auto-cancel extension_ui_request");
      try {
        this.writeFrame({ type: "extension_ui_response", id: req.id, cancelled: true });
      } catch {
        /* ignore */
      }
    }
  }

  private failPending(err: Error): void {
    if (this.pending.size === 0) return;
    for (const w of this.pending.values()) w.reject(err);
    this.pending.clear();
  }
}
