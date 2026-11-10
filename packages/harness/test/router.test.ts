/** Routing scenarios: the router as the only routing authority, workflow
 *  threads, fallbacks, loading and reloading. Fake Pi, offline. */
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pino from "pino";
import {
  loadRouting,
  seedRouting,
  watchRouting,
  type RouteFn,
  type RouterMessage,
  type Routing,
  type Workflow,
} from "../src/core/router.js";
import AgentMessagingPlugin from "../src/plugins/agent-messaging/index.js";
import type { Step } from "./fake-pi.js";
import { rig, type Rig } from "./helpers.js";

const OK: Step[] = [{ ack: "started" }, "save", { end: "stop" }, "settle"];
const log = pino({ level: process.env.TEST_LOG_LEVEL ?? "silent" });
const prompts = (r: Rig, thread: string) =>
  r.log().filter((l) => l.thread === thread && l.frame.type === "prompt");
const rows = (r: Rig) => r.db.listEvents({ limit: 1000, offset: 0, sortBy: "ts", sortDir: "asc" });
const threadsOf = (r: Rig) => rows(r).map((e) => e.thread_id).sort();
/** Core's notices on main about workflows it killed. */
const killNotices = (r: Rig) => rows(r).filter((e) => e.thread_id === "main" && e.plugin_id === "workflow");

const hasTools = () => ["jq", "curl"].every((t) => spawnSync("sh", ["-c", `command -v ${t}`]).status === 0);

/** A real agent-messaging inbox for agent "a", plus the seeded send CLI, so
 *  workflow scripts can message the agent. Start it before the rig (the rig
 *  needs its URL), then `attach` the rig. */
async function agentMessagingInbox(dir: string) {
  const prevSecret = process.env.COGNISPHERE_WEBHOOK_SECRET;
  process.env.COGNISPHERE_WEBHOOK_SECRET = "s3cret";
  const plugin = new AgentMessagingPlugin();
  const server = createServer((req, res) => {
    req.url = (req.url ?? "").replace("/webhook/a/agent-messaging", "");
    void plugin.handleHttpRequest(req, res);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    async attach(r: Rig): Promise<string> {
      await plugin.start({
        agentId: "a",
        agentDir: r.agentDir,
        stateDir: dir,
        inboxDir: dir,
        config: { allowMessageFrom: ["*"] },
        secrets: {},
        timezone: "UTC",
        log,
        notify: (name, p) =>
          r.runner.notify({ ...p, metadata: { ...p.metadata, _notification: name }, pluginId: "agent-messaging" }),
      });
      const sendCli = join(r.agentDir, "scripts", "agent-msg", "send");
      mkdirSync(dirname(sendCli), { recursive: true });
      copyFileSync(
        fileURLToPath(new URL("../src/plugins/agent-messaging/seed/scripts/agent-msg/send", import.meta.url)),
        sendCli,
      );
      chmodSync(sendCli, 0o755);
      return sendCli;
    },
    async close(): Promise<void> {
      await plugin.stop();
      server.close();
      if (prevSecret === undefined) delete process.env.COGNISPHERE_WEBHOOK_SECRET;
      else process.env.COGNISPHERE_WEBHOOK_SECRET = prevSecret;
    },
  };
}

function routing(route: RouteFn | null, ...wfs: Workflow[]): Routing {
  return { route, workflows: new Map(wfs.map((w) => [w.name, w])) };
}

/** A workflow whose script appends one JSON line per run to `out`:
 *  its stdin plus identity env. `body` runs after recording. */
function recorder(dir: string, name: string, body = ""): { wf: Workflow; out: string } {
  const out = join(dir, `${name}.out`);
  const script = join(dir, `${name}.sh`);
  writeFileSync(
    script,
    `#!/bin/sh
in=$(cat)
printf '{"in":%s,"env":"%s %s %s"}\\n' "$in" "$PI_AGENT_ID" "$PI_THREAD_ID" "$PWD" >> "${out}"
${body}
`,
  );
  chmodSync(script, 0o755);
  return { wf: { name, description: `records ${name}`, script }, out };
}
const runs = (out: string) =>
  existsSync(out)
    ? readFileSync(out, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { in: Record<string, unknown>; env: string })
    : [];

const notify = (
  r: Rig,
  opts: { plugin?: string; channel?: string; text?: string; metadata?: Record<string, unknown> } = {},
) =>
  r.runner.notify({
    pluginId: opts.plugin ?? "telegram",
    channelId: opts.channel ?? "42",
    text: opts.text ?? "hello",
    metadata: opts.metadata,
  });

test("no router: metadata.threadId is honoured, otherwise main", async () => {
  const r = rig({ script: { runs: [OK] } });
  try {
    notify(r, { metadata: { threadId: "ops" } });
    notify(r);
    await r.waitAllSettled();
    assert.deepEqual(threadsOf(r), ["main", "ops"]);
    assert.equal(prompts(r, "main").length, 1);
  } finally {
    await r.close();
  }
});

test("the router sees the message and picks threads; undefined keeps the fallback", async () => {
  const seen: RouterMessage[] = [];
  const r = rig({
    script: { runs: [OK] },
    routing: routing((m) => {
      seen.push(m);
      if (m.text === "fan") return ["a", "b", "a"];
      if (m.pluginId === "telegram") return `telegram:${m.channelId}`;
      return undefined;
    }),
  });
  try {
    notify(r, { metadata: { _notification: "message_received", chatType: "group" } });
    assert.equal(notify(r, { text: "fan" }).length, 2, "duplicate thread collapsed");
    notify(r, { plugin: "scheduler", metadata: { threadId: "reminders" } });
    notify(r, { plugin: "gws" });
    await r.waitAllSettled();
    assert.deepEqual(seen[0], {
      notification: "message_received",
      pluginId: "telegram",
      channelId: "42",
      text: "hello",
      metadata: { chatType: "group" },
      isSilent: false,
    });
    assert.deepEqual(threadsOf(r), ["a", "b", "main", "reminders", "telegram:42"]);
  } finally {
    await r.close();
  }
});

test("a router that throws or returns bad ids falls back; [] drops", async () => {
  const outs: Array<() => ReturnType<RouteFn>> = [
    () => {
      throw new Error("boom");
    },
    () => "../escape",
    () => "workflow:nope",
    () => [],
  ];
  let i = 0;
  const r = rig({ script: { runs: [OK] }, routing: routing(() => outs[i++]!()) });
  try {
    notify(r, { metadata: { threadId: "t1" } });
    notify(r);
    notify(r, { metadata: { threadId: "a/b" } });
    assert.deepEqual(notify(r), []);
    await r.waitAllSettled();
    assert.deepEqual(threadsOf(r), ["main", "main", "t1"], "unsafe metadata.threadId also rejected");
  } finally {
    await r.close();
  }
});

test("a workflow thread is queued and its script runs per row; no Pi", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cognisphere-wf-"));
  const { wf, out } = recorder(dir, "triage");
  const r = rig({ script: { runs: [OK] }, routing: routing(() => "workflow:triage", wf) });
  try {
    const [id] = notify(r, { text: "invoice #7", metadata: { _notification: "message_received", k: 1 } });
    await r.waitAllSettled();
    assert.equal(r.row(id!).status, "done");
    assert.equal(r.row(id!).thread_id, "workflow:triage");
    const [run] = runs(out);
    assert.deepEqual(run!.in, {
      id,
      notification: "message_received",
      pluginId: "telegram",
      channelId: "42",
      threadId: "workflow:triage",
      text: "invoice #7",
      metadata: { k: 1 },
      isSilent: false,
      attempts: 0,
    });
    assert.equal(run!.env, `a workflow:triage ${realpathSync(r.agentDir)}`);
    assert.equal(r.log().length, 0, "no Pi spawned");
  } finally {
    await r.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a workflow starts while a Pi turn holds the only slot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cognisphere-wf-"));
  const { wf, out } = recorder(dir, "taps");
  const r = rig({
    script: { runs: [[{ ack: "started" }, "hang"]] },
    routing: routing((m) => (m.pluginId === "telegram" ? "workflow:taps" : undefined), wf),
  });
  try {
    r.send("long turn");
    await r.waitFor(() => r.log().some((l) => l.frame.type === "prompt"), "the Pi turn");
    const [id] = notify(r, { text: "tap" });
    await r.waitFor(() => r.row(id!).status === "done", "the workflow row");
    assert.equal(runs(out).length, 1);
    assert.equal(r.runner.activeCount, 1, "the Pi turn is still running");
  } finally {
    await r.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a workflow runs one row at a time, in order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cognisphere-wf-"));
  const seq = join(dir, "seq");
  const { wf } = recorder(
    dir,
    "slow",
    `echo "start $(printf '%s' "$in" | sed 's/.*"text":"\\([^"]*\\)".*/\\1/')" >> ${seq}; sleep 0.2; echo end >> ${seq}`,
  );
  const r = rig({
    script: { runs: [OK] },
    routing: routing(() => "workflow:slow", wf),
    agentJson: { maxConcurrentSlots: 3 },
  });
  try {
    notify(r, { text: "one" });
    notify(r, { text: "two" });
    await r.waitAllSettled();
    assert.deepEqual(readFileSync(seq, "utf8").trim().split("\n"), ["start one", "end", "start two", "end"]);
  } finally {
    await r.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing workflow is not retried and core sends no notice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cognisphere-wf-"));
  const { wf, out } = recorder(dir, "bad", "echo nope >&2; exit 3");
  const r = rig({ script: { runs: [OK] }, routing: routing(() => "workflow:bad", wf), agentJson: { maxAttempts: 3 } });
  try {
    const [id] = notify(r);
    await r.waitAllSettled();
    assert.equal(r.row(id!).status, "failed");
    assert.match(r.row(id!).error ?? "", /exit 3: nope/);
    assert.equal(runs(out).length, 1, "ran once despite maxAttempts 3");
    assert.equal(rows(r).length, 1, "nothing posted to main: reporting is the script's job");
    assert.equal(r.log().length, 0, "no Pi spawned");
  } finally {
    await r.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a workflow reports its own error to main through agent-messaging (try/catch)", { skip: !hasTools() && "needs jq and curl" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cognisphere-wf-"));
  const { wf } = recorder(
    dir,
    "careful",
    `if ! false; then
  scripts/agent-msg/send --to-agent "$PI_AGENT_ID" --thread-id main --message "careful failed on event $(printf '%s' "$in" | jq -r .id)"
  exit 1
fi`,
  );
  const inbox = await agentMessagingInbox(dir);
  const r = rig({ script: { runs: [OK] }, serverBaseUrl: inbox.base, routing: routing((m) => (m.pluginId === "telegram" ? "workflow:careful" : undefined), wf) });
  try {
    await inbox.attach(r);
    const [id] = notify(r);
    await r.waitAllSettled();
    assert.equal(r.row(id!).status, "failed");
    const report = rows(r).find((e) => e.thread_id === "main")!;
    assert.equal(report.text, `careful failed on event ${id}`);
    assert.equal(JSON.parse(report.metadata!).fromThread, "workflow:careful");
    assert.equal(report.status, "done", "the agent got it on main");
  } finally {
    await inbox.close();
    await r.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hung workflow is killed at the timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cognisphere-wf-"));
  const { wf } = recorder(dir, "hang", "sleep 30");
  const r = rig({
    script: { runs: [OK] },
    routing: routing(() => "workflow:hang", wf),
    workflowTimeoutMs: 300,
  });
  try {
    const [id] = notify(r);
    await r.waitAllSettled();
    assert.equal(r.row(id!).status, "failed");
    assert.match(r.row(id!).error ?? "", /timed out/);
    const [notice, ...more] = killNotices(r);
    assert.equal(more.length, 0);
    assert.match(notice!.text, /^Workflow `hang` was killed on event \d+ because it ran past the 0.3-second timeout/);
    assert.match(notice!.text, /hello$/, "carries the original message");
    assert.deepEqual(JSON.parse(notice!.metadata!), { _notification: "workflow_killed", workflow: "hang", failedEventId: id });
    assert.equal(notice!.status, "done", "the agent got it on main");
  } finally {
    await r.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopping mid-run kills the script and fails the row (no retry)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cognisphere-wf-"));
  const { wf, out } = recorder(dir, "hang", "sleep 30");
  const r = rig({ script: { runs: [OK] }, routing: routing(() => "workflow:hang", wf) });
  try {
    const [id] = notify(r);
    await r.waitFor(() => runs(out).length === 1, "script started");
    await r.runner.stop();
    assert.equal(r.row(id!).status, "failed");
    assert.match(r.row(id!).error ?? "", /shutdown/);
    const [notice] = killNotices(r);
    assert.match(notice!.text, /because the agent was stopped while it was running/);
    assert.equal(notice!.status, "queued", "handled when the agent starts again");
  } finally {
    await r.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an aborted workflow run is cancelled, not reported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cognisphere-wf-"));
  const { wf, out } = recorder(dir, "hang", "sleep 30");
  const r = rig({ script: { runs: [OK] }, routing: routing(() => "workflow:hang", wf) });
  try {
    const [id] = notify(r);
    await r.waitFor(() => runs(out).length === 1, "script started");
    assert.equal(r.runner.abort("workflow:hang"), true);
    await r.waitAllSettled();
    assert.equal(r.row(id!).status, "cancelled");
    assert.equal(killNotices(r).length, 0);
  } finally {
    await r.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a queued row for a removed workflow fails instead of starting Pi", async () => {
  const r = rig({ script: { runs: [OK] }, routing: routing(null) });
  try {
    const id = r.db.enqueue({
      pluginId: "telegram",
      channelId: "42",
      threadId: "workflow:gone",
      text: "x",
      metadata: null,
      priority: 0,
      isSilent: false,
      doNotSteer: false,
    });
    r.runner.wake();
    await r.waitAllSettled();
    assert.equal(r.row(id).status, "failed");
    assert.match(r.row(id).error ?? "", /unknown workflow: gone/);
    assert.equal(r.log().length, 0, "no Pi spawned");
  } finally {
    await r.close();
  }
});

test("after a crash, an in-flight workflow row fails instead of re-running; Pi rows still retry", async () => {
  const r = rig({ script: { runs: [OK] }, routing: routing(null) });
  try {
    await r.runner.stop();
    const enqueue = (threadId: string) =>
      r.db.enqueue({ pluginId: "x", channelId: "c", threadId, text: "x", metadata: null, priority: 0, isSilent: false, doNotSteer: false });
    const wf = enqueue("workflow:gone");
    const pi = enqueue("t1");
    r.db.dequeueBatch("workflow:gone");
    r.db.dequeueBatch("t1");
    r.runner.start(); // sweeps in-flight rows as a crash
    await r.waitAllSettled();
    assert.equal(r.row(wf).status, "failed");
    assert.match(r.row(wf).error ?? "", /\[crash\]/);
    assert.equal(r.row(pi).status, "done");
    const [notice, ...more] = killNotices(r);
    assert.equal(more.length, 0);
    assert.match(notice!.text, new RegExp(`event ${wf} because the harness stopped unexpectedly`));
  } finally {
    await r.close();
  }
});

test("loadRouting reads the router and workflows; watchRouting applies edits and keeps the last good router", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "cognisphere-routing-"));
  const msg = (metadata: Record<string, unknown> = {}): RouterMessage => ({
    notification: "",
    pluginId: "admin",
    channelId: "c",
    text: "x",
    metadata,
    isSilent: false,
  });
  try {
    seedRouting(agentDir, log);
    const seeded = await loadRouting(agentDir, log);
    assert.equal(seeded.route!(msg(), []), "main", "starter router: main by default");
    assert.equal(seeded.route!(msg({ threadId: "t9" }), []), "t9", "starter router: honours metadata.threadId");

    const wf = join(agentDir, "workspace", "workflows");
    mkdirSync(join(wf, "good"), { recursive: true });
    writeFileSync(join(wf, "good", "workflow.json"), JSON.stringify({ description: "does good", script: "run.sh" }));
    writeFileSync(join(wf, "good", "run.sh"), "#!/bin/sh\n");
    chmodSync(join(wf, "good", "run.sh"), 0o755);
    mkdirSync(join(wf, "nodesc"));
    writeFileSync(join(wf, "nodesc", "workflow.json"), JSON.stringify({ script: "run.sh" }));
    mkdirSync(join(wf, "noexec"));
    writeFileSync(join(wf, "noexec", "workflow.json"), JSON.stringify({ description: "x", script: "run.sh" }));
    writeFileSync(join(wf, "noexec", "run.sh"), "#!/bin/sh\n");

    const router = join(agentDir, "workspace", "router.ts");
    const write = (src: string, bump: number) => {
      writeFileSync(router, src);
      const t = new Date(Date.now() + bump);
      utimesSync(router, t, t);
    };
    write(
      `export default (m: { text: string }, w: { name: string }[]) => m.text + ":" + w.map((x) => x.name).join(",");\n`,
      5000,
    );
    const one = await loadRouting(agentDir, log);
    assert.deepEqual([...one.workflows.keys()], ["good"], "no description / not executable: skipped");
    assert.equal(one.route!(msg(), [...one.workflows.values()]), "x:good");

    let applied: Routing = one;
    const stop = watchRouting(agentDir, one, (next) => (applied = next), log, 20);
    const waitApplied = async (pred: () => boolean) => {
      const until = Date.now() + 5000;
      while (!pred()) {
        if (Date.now() > until) throw new Error("reload not applied");
        await new Promise((res) => setTimeout(res, 20));
      }
    };
    try {
      write(`export default () => "edited";\n`, 9000);
      await waitApplied(() => applied.route?.(msg(), []) === "edited");
      write(`export default 42;\n`, 13000);
      await waitApplied(() => applied.error !== undefined);
      assert.equal(applied.route!(msg(), []), "edited", "a broken edit keeps the last good router");
    } finally {
      stop();
    }
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("a broken workspace (workflows is a file, a workflow folder unreadable) never throws", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "cognisphere-routing-"));
  try {
    mkdirSync(join(agentDir, "workspace"), { recursive: true });
    writeFileSync(join(agentDir, "workspace", "workflows"), "oops");
    seedRouting(agentDir, log); // can't create workflows/README.md: logged
    const first = await loadRouting(agentDir, log);
    assert.equal(first.workflows.size, 0);
    assert.equal(first.route!({ notification: "", pluginId: "x", channelId: "c", text: "", metadata: {}, isSilent: false }, []), "main");

    let applied: Routing | undefined;
    const stop = watchRouting(agentDir, first, (r) => (applied = r), log, 20);
    rmSync(join(agentDir, "workspace", "workflows"));
    mkdirSync(join(agentDir, "workspace", "workflows", "locked"), { recursive: true });
    chmodSync(join(agentDir, "workspace", "workflows", "locked"), 0o000);
    await new Promise((res) => setTimeout(res, 300));
    stop();
    chmodSync(join(agentDir, "workspace", "workflows", "locked"), 0o755);
    assert.ok(applied, "reload ran");
    assert.equal(applied.workflows.size, 0);
    assert.ok(applied.route, "router kept");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});


test(
  "round trip: a workflow invokes the agent through agent-messaging, and the reply runs it again",
  { skip: !hasTools() && "needs jq and curl" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "cognisphere-wf-"));
    // A Telegram message: hand it to thread `work`. The agent's reply (an
    // agent_message on this workflow's thread): just recorded.
    const { wf, out } = recorder(
      dir,
      "triage",
      `[ "$(printf '%s' "$in" | jq -r .notification)" = agent_message ] && exit 0
scripts/agent-msg/send --to-agent "$PI_AGENT_ID" --thread-id work --message "triage: $(printf '%s' "$in" | jq -r .text)"`,
    );
    const inbox = await agentMessagingInbox(dir);
    const r = rig({
      script: { runs: [OK] },
      serverBaseUrl: inbox.base,
      routing: routing((m) => (m.pluginId === "telegram" ? "workflow:triage" : undefined), wf),
    });
    try {
      const sendCli = await inbox.attach(r);
      notify(r, { text: "invoice #7", metadata: { _notification: "message_received" } });
      await r.waitFor(() => rows(r).some((e) => e.thread_id === "work"), "row on thread work");
      const work = rows(r).find((e) => e.thread_id === "work")!;
      assert.equal(work.text, "triage: invoice #7");
      assert.equal(JSON.parse(work.metadata!).fromThread, "workflow:triage");

      // The agent (on thread `work`) replies to the workflow's thread. Async:
      // the inbox is served by this same process.
      await promisify(execFile)(sendCli, ["--to-agent", "a", "--thread-id", "workflow:triage", "--message", "filed"], {
        cwd: r.agentDir,
        env: { ...process.env, PI_AGENT_ID: "a", PI_THREAD_ID: "work", HARNESS_BASE_URL: inbox.base },
      });
      await r.waitFor(() => runs(out).length === 2, "workflow ran on the reply");
      await r.waitAllSettled();
      const reply = runs(out)[1]!.in as { text: string; notification: string; metadata: { fromThread: string } };
      assert.equal(reply.notification, "agent_message");
      assert.equal(reply.text, "filed");
      assert.equal(reply.metadata.fromThread, "work");
      assert.deepEqual(
        rows(r).map((e) => [e.thread_id, e.status]),
        [
          ["workflow:triage", "done"],
          ["work", "done"],
          ["workflow:triage", "done"],
        ],
      );
    } finally {
      await inbox.close();
      await r.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
