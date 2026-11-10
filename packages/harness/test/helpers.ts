/** Shared setup for runner tests: a temporary harness root, one agent, a real
 *  SQLite queue, and an `AgentRunner` that starts the fake pi (or real pi). */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { AgentDb, type EventRow } from "../src/core/queue.js";
import type { Routing } from "../src/core/router.js";
import { AgentRunner, type RunnerOpts } from "../src/core/runner.js";
import type { AgentJson } from "../src/core/types.js";
import type { Script } from "./fake-pi.js";

const FAKE_PI = fileURLToPath(new URL("./fake-pi.ts", import.meta.url));

export interface LogLine {
  thread: string;
  spawn: number;
  t: number;
  frame: { type: string; message?: string };
}

export interface Rig {
  runner: AgentRunner;
  db: AgentDb;
  agentDir: string;
  /** Enqueue one message from the admin plugin. */
  send(text: string, opts?: { thread?: string; doNotSteer?: boolean }): number;
  row(id: number): EventRow;
  /** Poll until `pred` holds (default timeout 5 s). */
  waitFor(pred: () => boolean, what: string, ms?: number): Promise<void>;
  /** Wait until every row is done, failed, cancelled or dead. */
  waitAllSettled(ms?: number): Promise<void>;
  /** Frames the fake pi received (and its start/end markers). */
  log(): LogLine[];
  /** Entries of a thread's session file. */
  sessionEntries(thread: string): Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export function rig(opts: {
  script?: Script;
  agentJson?: Partial<AgentJson>;
  /** Start the bundled real pi instead of the fake. */
  realPi?: boolean;
  envSecrets?: Record<string, string>;
  routing?: Routing;
  serverBaseUrl?: string;
  workflowTimeoutMs?: number;
}): Rig {
  const root = mkdtempSync(join(tmpdir(), "cognisphere-test-"));
  const agentDir = join(root, "h", "agents", "a");
  mkdirSync(join(agentDir, "system_prompts"), { recursive: true });
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  writeFileSync(join(agentDir, "system_prompts", "0-test.md"), "You are a test agent. Keep replies short.\n");
  const scriptPath = join(root, "script.json");
  if (opts.script) writeFileSync(scriptPath, JSON.stringify(opts.script));

  const db = new AgentDb(join(agentDir, "sessions", ".events.db"));
  const runnerOpts: RunnerOpts = {
    rootDir: root,
    harnessId: "h",
    agentId: "a",
    agentJson: {
      name: "a",
      model: { provider: "fake", id: "fake" },
      ...opts.agentJson,
    },
    db,
    serverBaseUrl: opts.serverBaseUrl ?? "http://127.0.0.1:1",
    timezone: "UTC",
    envSecrets: opts.envSecrets,
    routing: opts.routing,
    workflowTimeoutMs: opts.workflowTimeoutMs,
    piCommand: opts.realPi ? undefined : [process.execPath, FAKE_PI, scriptPath],
    log: pino({ level: process.env.TEST_LOG_LEVEL ?? "silent" }),
  };
  const runner = new AgentRunner(runnerOpts);
  runner.start();

  const row = (id: number): EventRow => {
    const r = db.listEvents({ limit: 1000, offset: 0 }).find((e) => e.id === id);
    if (!r) throw new Error(`no row ${id}`);
    return r;
  };
  const waitFor = async (pred: () => boolean, what: string, ms = 5000): Promise<void> => {
    const until = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const terminal = new Set(["done", "failed", "cancelled", "dead"]);

  return {
    runner,
    db,
    agentDir,
    send: (text, o = {}) =>
      runner.notify({
        pluginId: "admin",
        channelId: o.thread ?? "t1",
        metadata: { threadId: o.thread ?? "t1" },
        text,
        doNotSteer: o.doNotSteer,
      })[0]!,
    row,
    waitFor,
    waitAllSettled: (ms) =>
      waitFor(
        () => db.listEvents({ limit: 1000, offset: 0 }).every((e) => terminal.has(e.status)),
        "all rows to settle",
        ms,
      ),
    log: () =>
      existsSync(`${scriptPath}.log`)
        ? readFileSync(`${scriptPath}.log`, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as LogLine)
        : [],
    sessionEntries: (thread) => {
      const sessionId = db.getThreadSessionId(thread);
      const file = join(agentDir, "sessions", thread, `${sessionId}.jsonl`);
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
    close: async () => {
      await runner.stop();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
