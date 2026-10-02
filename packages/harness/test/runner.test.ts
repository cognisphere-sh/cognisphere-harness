/** Runner + queue scenarios against the fake pi (phase 1). Offline, no model. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Step } from "./fake-pi.js";
import { rig, type Rig } from "./helpers.js";

const OK: Step[] = [{ ack: "started" }, "save", { end: "stop" }, "settle"];
const prompts = (r: Rig, thread = "t1") =>
  r.log().filter((l) => l.thread === thread && l.frame.type === "prompt");
const receipts = (r: Rig, thread = "t1") =>
  r.sessionEntries(thread).filter((e) => e.customType === "cognisphere.delivery");

test("one message, one reply: done, linked to its receipt", async () => {
  const r = rig({ script: { runs: [OK] } });
  try {
    const id = r.send("hello");
    await r.waitAllSettled();
    const row = r.row(id);
    assert.equal(row.status, "done");
    assert.equal(row.attempts, 0);
    const user = r.sessionEntries("t1").find((e) => (e.message as { role?: string })?.role === "user");
    assert.ok(user, "user entry saved");
    assert.equal(row.pi_entry_id, user.id);
    assert.deepEqual(receipts(r).map((e) => e.data), [{ entryId: user.id, eventIds: [id] }]);
  } finally {
    await r.close();
  }
});

test("a message arriving mid-turn steers into the same batch", async () => {
  const r = rig({ script: { runs: [[{ ack: "started" }, "save", { waitSteers: 1 }, "save", { end: "stop" }, "settle"]] } });
  try {
    const a = r.send("first");
    await r.waitFor(() => r.row(a).pi_entry_id !== null, "first receipt");
    const b = r.send("second");
    await r.waitAllSettled();
    assert.equal(r.row(a).status, "done");
    assert.equal(r.row(b).status, "done");
    assert.ok(r.row(b).pi_entry_id && r.row(b).pi_entry_id !== r.row(a).pi_entry_id);
    assert.equal(prompts(r).length, 1, "one Pi process");
    assert.equal(r.log().filter((l) => l.frame.type === "steer").length, 1);
  } finally {
    await r.close();
  }
});

test("a doNotSteer message waits for the next batch", async () => {
  const r = rig({ script: { runs: [[{ ack: "started" }, "save", { sleep: 200 }, { end: "stop" }, "settle"]] } });
  try {
    const a = r.send("first");
    await r.waitFor(() => r.row(a).pi_entry_id !== null, "first receipt");
    const b = r.send("later", { doNotSteer: true });
    await r.waitAllSettled();
    assert.equal(r.row(b).status, "done");
    assert.equal(r.log().filter((l) => l.frame.type === "steer").length, 0);
    assert.equal(prompts(r).length, 2, "second batch for the doNotSteer row");
  } finally {
    await r.close();
  }
});

test("Pi crashes after saving the input: retried as a continuation nudge", async () => {
  const r = rig({ script: { runs: [[{ ack: "started" }, "save", { exit: 1 }], OK] } });
  try {
    const id = r.send("do the thing");
    await r.waitAllSettled();
    assert.equal(r.row(id).status, "done");
    assert.equal(r.row(id).attempts, 1);
    const second = prompts(r)[1]!.frame.message!;
    assert.match(second, /Continuation: true/);
    assert.doesNotMatch(second, /do the thing/, "original text not resent");
  } finally {
    await r.close();
  }
});

test("Pi crashes before saving the input: the text is resent", async () => {
  const r = rig({ script: { runs: [[{ ack: "started" }, { exit: 1 }], OK] } });
  try {
    const id = r.send("do the thing");
    await r.waitAllSettled();
    assert.equal(r.row(id).status, "done");
    const second = prompts(r)[1]!.frame.message!;
    assert.match(second, /Retry: true/);
    assert.match(second, /do the thing/);
  } finally {
    await r.close();
  }
});

test("attempts exhausted: failed, other threads unaffected", async () => {
  const r = rig({
    agentJson: { maxAttempts: 2 },
    script: {
      runs: [OK],
      threads: { bad: [[{ ack: "started" }, "save", { end: "error" }, "settle"]] },
    },
  });
  try {
    const bad = r.send("fails", { thread: "bad" });
    const good = r.send("works", { thread: "good" });
    await r.waitAllSettled();
    assert.equal(r.row(bad).status, "failed");
    assert.equal(r.row(bad).attempts, 2);
    assert.match(r.row(bad).error ?? "", /^\[agent_error\] fake provider error/);
    assert.equal(r.row(good).status, "done");
  } finally {
    await r.close();
  }
});

test("two threads with maxConcurrentSlots 1 run one after another", async () => {
  const slow: Step[] = [{ ack: "started" }, "save", { sleep: 150 }, { end: "stop" }, "settle"];
  const r = rig({ agentJson: { maxConcurrentSlots: 1 }, script: { runs: [slow] } });
  try {
    r.send("a", { thread: "x" });
    r.send("b", { thread: "y" });
    await r.waitAllSettled();
    const span = (thread: string) => {
      const ls = r.log().filter((l) => l.thread === thread);
      return [ls.find((l) => l.frame.type === "start")!.t, ls.find((l) => l.frame.type === "end")!.t];
    };
    const [first, second] = [span("x"), span("y")].sort((p, q) => p[0]! - q[0]!);
    assert.ok(first![1]! <= second![0]!, "second Pi starts after the first ends");
  } finally {
    await r.close();
  }
});

test("stop mid-turn requeues the row but counts the attempt (core known issue #5)", async () => {
  const r = rig({ script: { runs: [[{ ack: "started" }, "save", "hang"]] } });
  try {
    const id = r.send("long task");
    await r.waitFor(() => r.row(id).pi_entry_id !== null, "receipt");
    await r.runner.stop();
    // ponytail: documents today's behavior. When #5 is fixed, expect attempts 0.
    assert.equal(r.row(id).status, "queued");
    assert.equal(r.row(id).attempts, 1);
  } finally {
    await r.close();
  }
});

test("abort mid-turn cancels the row", async () => {
  const r = rig({ script: { runs: [[{ ack: "started" }, "save", "hang"]] } });
  try {
    const id = r.send("long task");
    await r.waitFor(() => r.row(id).pi_entry_id !== null, "receipt");
    assert.ok(r.runner.abort("t1"));
    await r.waitAllSettled();
    assert.equal(r.row(id).status, "cancelled");
  } finally {
    await r.close();
  }
});

test("Pi retries an error itself: done after agent_settled", async () => {
  const r = rig({
    // The pause stands in for Pi's retry backoff; a runner that stopped at the
    // first agent_end would close Pi during it.
    script: {
      runs: [[{ ack: "started" }, "save", { end: "error", willRetry: true }, { sleep: 200 }, { end: "stop" }, "settle"]],
    },
  });
  try {
    const id = r.send("flaky");
    await r.waitAllSettled();
    assert.equal(r.row(id).status, "done");
    assert.equal(r.row(id).attempts, 0);
    assert.equal(prompts(r).length, 1, "no queue retry");
  } finally {
    await r.close();
  }
});

test("Pi exits after agent_end but before agent_settled: crash", async () => {
  const r = rig({
    agentJson: { maxAttempts: 1 },
    script: { runs: [[{ ack: "started" }, "save", { end: "stop" }, { exit: 0 }]] },
  });
  try {
    const id = r.send("hi");
    await r.waitAllSettled();
    assert.equal(r.row(id).status, "failed");
    assert.match(r.row(id).error ?? "", /^\[crash\] pi exited before agent_settled/);
  } finally {
    await r.close();
  }
});

test("a prompt an extension handled is done without a receipt", async () => {
  const r = rig({ script: { runs: [[{ ack: "handled" }]] } });
  try {
    const id = r.send("/remember x");
    await r.waitAllSettled();
    assert.equal(r.row(id).status, "done");
    assert.equal(r.row(id).pi_entry_id, null);
  } finally {
    await r.close();
  }
});

test("a steer an extension handled is done without a receipt", async () => {
  const r = rig({
    script: { steer: "handled", runs: [[{ ack: "started" }, "save", { waitSteers: 1 }, { end: "stop" }, "settle"]] },
  });
  try {
    const a = r.send("first");
    await r.waitFor(() => r.row(a).pi_entry_id !== null, "first receipt");
    const b = r.send("/remember x");
    await r.waitAllSettled();
    assert.equal(r.row(a).status, "done");
    assert.equal(r.row(b).status, "done");
    assert.equal(r.row(b).pi_entry_id, null);
    assert.equal(prompts(r).length, 1, "not resent");
  } finally {
    await r.close();
  }
});

test("a second Pi process on the same session adds no duplicate receipts", async () => {
  const r = rig({ script: { runs: [OK] } });
  try {
    const a = r.send("one");
    await r.waitAllSettled();
    const b = r.send("two");
    await r.waitAllSettled();
    const ids = receipts(r).map((e) => (e.data as { eventIds: number[] }).eventIds);
    assert.deepEqual(ids, [[a], [b]]);
  } finally {
    await r.close();
  }
});
