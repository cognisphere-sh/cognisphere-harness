/**
 * fake-pi — stands in for `pi --mode rpc` in runner tests (phase 1).
 *
 * Usage (via the runner's test-only `piCommand` option):
 *   node test/fake-pi.ts <script.json> <...pi args>
 *
 * It speaks pi's RPC JSON lines, saves entries to the `--session` file like
 * pi, and loads the real delivery-receipts extension (the first
 * `--extension`) through a small stand-in extension API. Instead of a model
 * it follows a script: `runs[n]` is the step list for the n-th spawn on a
 * thread (the last list repeats); `threads[<threadId>]` overrides `runs` for
 * one thread. Every frame it receives, plus `start`/`end` markers, is
 * appended to `<script>.log` for assertions.
 *
 * Runs with Node's built-in type stripping, so only erasable TS syntax here.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";

export type Step =
  | { ack: "started" | "queued" | "handled" }
  | "save"
  | { end: "stop" | "error" | "toolUse"; willRetry?: boolean }
  | "settle"
  | { waitSteers: number }
  | { sleep: number }
  | { exit: number }
  | "hang";

export interface Script {
  runs: Step[][];
  threads?: Record<string, Step[][]>;
  /** Disposition for every steer (default `queued`). */
  steer?: "queued" | "handled";
}

interface Entry {
  type: string;
  id: string;
  [k: string]: unknown;
}
type Handler = (event: { type: string }, ctx: unknown) => unknown;

const [scriptPath, ...piArgs] = process.argv.slice(2);
if (!scriptPath) throw new Error("fake-pi: missing script path");
const script = JSON.parse(readFileSync(scriptPath, "utf8")) as Script;

const argAfter = (flag: string): string | undefined => {
  const i = piArgs.indexOf(flag);
  return i >= 0 ? piArgs[i + 1] : undefined;
};
const sessionFile = argAfter("--session");
const extensionPath = argAfter("--extension");
// Session files live at sessions/<threadId>/<sessionId>.jsonl.
const thread = sessionFile ? basename(dirname(sessionFile)) : "";

const logPath = `${scriptPath}.log`;
const countPath = `${scriptPath}.${thread}.count`;
const spawnIndex = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0;
writeFileSync(countPath, String(spawnIndex + 1));
const runs = script.threads?.[thread] ?? script.runs;
const steps = runs[Math.min(spawnIndex, runs.length - 1)] ?? [];

const log = (frame: unknown): void =>
  appendFileSync(
    logPath,
    `${JSON.stringify({ thread, spawn: spawnIndex, t: Date.now(), frame })}\n`,
  );
const out = (obj: unknown): void => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

// ── session file ───────────────────────────────────────────
const entries: Entry[] =
  sessionFile && existsSync(sessionFile)
    ? readFileSync(sessionFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Entry)
    : [];
const append = (fields: { type: string; [k: string]: unknown }): Entry => {
  const entry: Entry = { ...fields, id: randomUUID().slice(0, 8), timestamp: new Date().toISOString() };
  entries.push(entry);
  if (sessionFile) appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
  return entry;
};

// ── stand-in extension API (enough for pi-delivery-receipts) ─
const handlers = new Map<string, Handler[]>();
const api = {
  on(event: string, h: Handler): void {
    handlers.set(event, [...(handlers.get(event) ?? []), h]);
  },
  appendEntry(customType: string, data: unknown): void {
    out({ type: "entry_appended", entry: append({ type: "custom", customType, data }) });
  },
};
const ctx = { sessionManager: { getEntries: () => entries }, ui: { setStatus() {} } };
const emit = async (type: string): Promise<void> => {
  for (const h of handlers.get(type) ?? []) await h({ type }, ctx);
};

// ── input ──────────────────────────────────────────────────
let pending: string[] = [];
let steersSeen = 0;
let steerWaiter: (() => void) | undefined;

async function runSteps(promptId: string | undefined): Promise<void> {
  for (const step of steps) {
    if (step === "save") {
      for (const text of pending) {
        append({ type: "message", message: { role: "user", content: text } });
        await emit("message_start");
      }
      pending = [];
      await emit("turn_start");
    } else if (step === "settle") {
      out({ type: "agent_settled" });
      await emit("agent_settled");
    } else if (step === "hang") {
      return new Promise(() => {});
    } else if ("ack" in step) {
      out({ id: promptId, type: "response", command: "prompt", success: true, data: { disposition: step.ack } });
      if (step.ack === "handled") pending = [];
    } else if ("end" in step) {
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: step.end === "stop" ? "ok" : "" }],
        stopReason: step.end,
        ...(step.end === "error" ? { errorMessage: "fake provider error" } : {}),
      };
      append({ type: "message", message: assistant });
      out({ type: "agent_end", messages: [assistant], willRetry: step.willRetry ?? false });
      await emit("agent_end");
    } else if ("waitSteers" in step) {
      const n = step.waitSteers;
      while (steersSeen < n) await new Promise<void>((r) => (steerWaiter = r));
    } else if ("sleep" in step) {
      await new Promise((r) => setTimeout(r, step.sleep));
    } else if ("exit" in step) {
      process.exit(step.exit);
    }
  }
}

function onFrame(frame: { id?: string; type: string; message?: string }): void {
  log(frame);
  if (frame.type === "prompt") {
    pending.push(frame.message ?? "");
    void runSteps(frame.id);
  } else if (frame.type === "steer") {
    const disposition = script.steer ?? "queued";
    if (disposition === "queued") pending.push(frame.message ?? "");
    out({ id: frame.id, type: "response", command: "steer", success: true, data: { disposition } });
    steersSeen++;
    steerWaiter?.();
  } else if (frame.type === "abort") {
    const assistant = { role: "assistant", content: [], stopReason: "aborted" };
    out({ type: "agent_end", messages: [assistant], willRetry: false });
    out({ type: "agent_settled" });
  }
}

if (extensionPath) {
  const mod = (await import(extensionPath)) as { default: (pi: typeof api) => void };
  mod.default(api);
}
await emit("session_start");
log({ type: "start" });

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) onFrame(JSON.parse(line) as { type: string });
  }
});
// Like pi: closing stdin shuts it down.
process.stdin.on("end", () => {
  log({ type: "end" });
  process.exit(0);
});
