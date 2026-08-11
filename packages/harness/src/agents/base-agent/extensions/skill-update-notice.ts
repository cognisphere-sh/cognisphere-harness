/**
 * skill-update-notice — a pi extension loaded into every spawned `pi --mode
 * rpc` child (see `runner.ts:spawnPi`). Closes the recency gap between the
 * system prompt and skill reads in history.
 *
 * The problem: `<available_skills>` in the system prompt is rebuilt on every
 * spawn, so it always advertises the CURRENT skill version — but it sits at
 * position 0 of the context, BEFORE any `read` of `SKILL.md` in the
 * conversation history. When a skill is bumped between batches, the model
 * sees prompt says v1.2.0 / my read said v1.1.0 and, reasoning by context
 * order, tends to trust the (later) read — concluding the prompt is stale
 * instead of realizing the file changed after the read.
 *
 * The fix: track the version of each SKILL.md the agent actually saw (via
 * its `read` tool, or its own `edit`/`write`), and when the file's current
 * version no longer matches, inject ONE persistent notice per (skill, new
 * version) as a standalone `<harness-metadata>` message:
 *
 *   SystemMessage: Skill "<name>" changed after you last read it
 *   (v<read> -> v<current>). <latest CHANGELOG.md entry>
 *
 * Mechanics:
 * - `tool_result` on read/edit/write of a `SKILL.md` records the file's
 *   frontmatter `version:` as the agent's last-known version, persisted as a
 *   custom session entry so it survives process respawns (the harness spawns
 *   a fresh pi per batch).
 * - `before_agent_start` (not streaming → direct append, lands before the
 *   batch's first LLM call) and `turn_start` (mid-run bumps, delivered at
 *   the next steer seam) compare last-known vs current and emit the notice.
 * - Sent notices are persisted as custom entries too, keyed
 *   `<path>@<version>`, so each update is announced exactly once.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const NOTICE_TYPE = "skill-update-notice";
const READ_TYPE = "skill-update-notice.read";
const SENT_TYPE = "skill-update-notice.sent";

/** Parse `name:` and `metadata.version:` out of a SKILL.md frontmatter. */
const skillMeta = (path: string): { name: string; version: string } | null => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!fm) return null;
  const version = /^\s*version:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fm)?.[1]?.trim();
  if (!version) return null;
  const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? basename(dirname(path));
  return { name, version };
};

/** Newest entry (first `## ` section) of the skill's CHANGELOG.md, if any. */
const latestChangelog = (skillDir: string): string | null => {
  let text: string;
  try {
    text = readFileSync(join(skillDir, "CHANGELOG.md"), "utf8");
  } catch {
    return null;
  }
  const start = text.search(/^## /m);
  if (start < 0) return null;
  const rest = text.slice(start);
  const next = rest.slice(3).search(/^## /m);
  const entry = (next < 0 ? rest : rest.slice(0, next + 3)).trim();
  return entry.length > 800 ? `${entry.slice(0, 800)}…` : entry;
};

export default function skillUpdateNotice(pi: ExtensionAPI): void {
  // Version of each SKILL.md as the agent last saw it (abs path → version).
  const lastKnown = new Map<string, string>();
  // Updates already announced, keyed `<abs path>@<new version>`.
  const notified = new Set<string>();
  let seeded = false;

  // Rebuild both maps from the session's custom entries — the harness spawns
  // a fresh pi per batch, and the spawn gap is exactly when skills change.
  const ensureSeeded = (ctx: ExtensionContext): void => {
    if (seeded) return;
    seeded = true;
    for (const e of ctx.sessionManager.getEntries()) {
      if (e.type !== "custom") continue;
      const d = e.data as { path?: string; version?: string } | undefined;
      if (!d?.path || !d.version) continue;
      if (e.customType === READ_TYPE) lastKnown.set(d.path, d.version);
      else if (e.customType === SENT_TYPE) notified.add(`${d.path}@${d.version}`);
    }
  };

  const check = (): void => {
    for (const [path, readVersion] of lastKnown) {
      const meta = skillMeta(path);
      if (!meta || meta.version === readVersion) continue;
      const key = `${path}@${meta.version}`;
      if (notified.has(key)) continue;
      notified.add(key);
      pi.appendEntry(SENT_TYPE, { path, version: meta.version });
      const changelog = latestChangelog(dirname(path));
      const lines = [
        `SystemMessage: Skill "${meta.name}" (${path}) changed after you last read it: v${readVersion} -> v${meta.version}. This is why its advertised version in <available_skills> differs from the copy in your history.`,
        changelog ? `Latest changelog entry:\n${changelog}` : "(No changelog entry found.)",
        `Act per the changelog, or re-read ${path} before following this skill again.`,
      ];
      pi.sendMessage(
        {
          customType: NOTICE_TYPE,
          content: `<harness-metadata>\n${lines.join("\n")}\n</harness-metadata>`,
          display: true,
        },
        { deliverAs: "steer", triggerTurn: false },
      );
    }
  };

  pi.on("session_start", (_event, ctx) => ensureSeeded(ctx));

  // Record what the agent saw. Its own edit/write counts too — after bumping
  // a skill itself it already knows the new version, so no notice is owed.
  pi.on("tool_result", (event, ctx) => {
    ensureSeeded(ctx);
    if (event.isError) return;
    if (event.toolName !== "read" && event.toolName !== "edit" && event.toolName !== "write") return;
    const p = (event.input as { path?: unknown }).path;
    if (typeof p !== "string" || basename(p) !== "SKILL.md") return;
    const abs = resolve(ctx.cwd, p);
    const version = skillMeta(abs)?.version;
    if (!version || lastKnown.get(abs) === version) return;
    lastKnown.set(abs, version);
    pi.appendEntry(READ_TYPE, { path: abs, version });
  });

  pi.on("before_agent_start", (_event, ctx) => {
    ensureSeeded(ctx);
    check();
  });

  pi.on("turn_start", (_event, ctx) => {
    ensureSeeded(ctx);
    check();
  });
}
