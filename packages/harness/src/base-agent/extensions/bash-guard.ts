/**
 * bash-guard — a pi extension loaded into every spawned `pi --mode rpc` child
 * (see `runner.ts:spawnPi`). Prepends `set -u` to every agent `bash` command
 * so that a `$...` inside double quotes (e.g. `--text "costs $100"`, where
 * bash expands the unset `$1` and silently sends "costs 00") fails loudly
 * with an "unbound variable" error instead of silently corrupting CLI
 * arguments. Applies to every CLI the agent invokes, with no reliance on
 * prompt guidance. The agent can opt out per-command with `set +u`.
 *
 * When the error fires, a quoting hint is appended to the tool result so the
 * agent can self-correct without guessing what "unbound variable" means.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HINT =
  "Hint: bash expanded a `$...` inside double quotes before your command ran " +
  "(commands run under `set -u`, which turns this into an error instead of " +
  "silently deleting the text). Put literal text in single quotes; if the " +
  "text contains single quotes, write it to a file first or use a quoted " +
  "heredoc (<<'EOF').";

export default function bashGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;
    event.input.command = `set -u; ${event.input.command}`;
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash" || !event.isError) return;
    const hasUnbound = event.content.some(
      (c) => c.type === "text" && c.text.includes("unbound variable"),
    );
    if (!hasUnbound) return;
    return { content: [...event.content, { type: "text" as const, text: HINT }] };
  });
}
