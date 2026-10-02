/**
 * Runner against the real bundled pi and a real model (phase 1). Opt-in:
 * needs PI_TEST_PROVIDER, PI_TEST_MODEL and PI_TEST_API_KEY (scripts/test.mjs
 * loads them from `.env.test` or asks for them); otherwise every test skips.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { findProviderInCatalog } from "../src/core/models-catalog.js";
import { rig } from "./helpers.js";

const provider = process.env.PI_TEST_PROVIDER ?? "";
const model = process.env.PI_TEST_MODEL ?? "";
const apiKey = process.env.PI_TEST_API_KEY ?? "";
const keyField = findProviderInCatalog(provider)?.credentials.find((c) => c.key === "apiKey");

const skip = !provider || !model || !apiKey
  ? "set PI_TEST_PROVIDER, PI_TEST_MODEL and PI_TEST_API_KEY (or run `pnpm test` in a terminal)"
  : !keyField?.envVar
    ? `provider "${provider}" has no single API-key credential in the model catalog`
    : false;

// Real pi reads its config folder from here; keep ~/.pi/agent and every
// harness's .secrets/pi out of it.
const piDir = mkdtempSync(join(tmpdir(), "cognisphere-test-pi-"));
process.env.PI_CODING_AGENT_DIR = piDir;
after(() => rmSync(piDir, { recursive: true, force: true }));

const realRig = () =>
  rig({
    realPi: true,
    agentJson: { model: { provider, id: model, thinkingLevel: "low" } },
    envSecrets: { [keyField!.envVar!]: apiKey },
  });

test("real pi: one message gets a receipt and is done", { skip, timeout: 180_000 }, async () => {
  const r = realRig();
  try {
    const id = r.send("Reply with exactly: pong");
    await r.waitAllSettled(150_000);
    const row = r.row(id);
    assert.equal(row.status, "done", row.error ?? "");
    assert.ok(row.pi_entry_id, "linked to a session entry");
    const receipts = r.sessionEntries("t1").filter((e) => e.customType === "cognisphere.delivery");
    assert.deepEqual(receipts.map((e) => e.data), [{ entryId: row.pi_entry_id, eventIds: [id] }]);
  } finally {
    await r.close();
  }
});

test("real pi: a mid-turn message steers into the same batch", { skip, timeout: 180_000 }, async () => {
  const r = realRig();
  let batches = 0;
  r.runner.on("batch-completed", () => batches++);
  try {
    const a = r.send("Use the bash tool to run `sleep 8; echo slept`, then reply with its output.");
    await r.waitFor(() => r.row(a).pi_entry_id !== null, "first receipt", 60_000);
    const b = r.send("Also add the word 'steered' to your reply.");
    await r.waitAllSettled(150_000);
    assert.equal(r.row(a).status, "done", r.row(a).error ?? "");
    assert.equal(r.row(b).status, "done", r.row(b).error ?? "");
    assert.ok(r.row(b).pi_entry_id);
    assert.equal(batches, 1, "one Pi process handled both");
  } finally {
    await r.close();
  }
});

test("real pi: abort mid-turn cancels the row", { skip, timeout: 180_000 }, async () => {
  const r = realRig();
  try {
    const id = r.send("Use the bash tool to run `sleep 30; echo late`, then reply with its output.");
    await r.waitFor(() => r.row(id).pi_entry_id !== null, "receipt", 60_000);
    assert.ok(r.runner.abort("t1"));
    await r.waitAllSettled(30_000);
    assert.equal(r.row(id).status, "cancelled");
  } finally {
    await r.close();
  }
});
