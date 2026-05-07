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
}

type RpcMessage =
  | RpcResponse
  | ExtensionUiRequest
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: unknown[] }
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
  private agentEndHandler: (() => void) | undefined;
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

  onAgentEnd(h: () => void): void {
    this.agentEndHandler = h;
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
      this.agentEndHandler?.();
      return;
    }
    if (p.type === "extension_ui_request") {
      this.handleExtensionUi(p as ExtensionUiRequest);
      return;
    }
  }

  private handleExtensionUi(req: ExtensionUiRequest): void {
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
