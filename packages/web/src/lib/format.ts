/**
 * Linkify file paths in chat text.
 *
 * The agent runs with cwd = AgentDir, so any reference like
 *   `workspace/foo.md`, `./scripts/x.sh`, `sessions/<id>/msg.jsonl`,
 *   `skills/scheduler/SKILL.md`
 * resolves under the agent dir. We turn those into <a> elements that hit
 * `/api/agents/<id>/fs/raw?path=...`.
 *
 * Pattern matches:
 *   • backticked paths: `…path…`
 *   • bare relative paths with at least one slash and a known extension OR
 *     starting with a known top-level dir (workspace/, scripts/, skills/,
 *     extensions/, sessions/, plugins/, system_prompts/, assets/, uploads/,
 *     bootstrap/)
 *
 * To keep this conservative, absolute paths and URLs are left alone so
 * we don't accidentally rewrite e.g. https://… or /etc/hosts.
 */

const TOP_DIRS = [
  "workspace",
  "scripts",
  "skills",
  "extensions",
  "sessions",
  "plugins",
  "system_prompts",
  "assets",
  "uploads",
  "bootstrap",
];

const KNOWN_EXTS =
  "md|txt|json|jsonl|js|ts|tsx|jsx|py|sh|yaml|yml|toml|csv|log|html|pdf|png|jpg|jpeg|gif|webp|svg|mp4|mp3|wav";

const TOP_DIR_PAT = TOP_DIRS.join("|");

const PATH_RE = new RegExp(
  // backticked OR (top-dir start | rel-with-ext)
  "(`(?:[^`]+)`)" +
    "|(?:(?<![./\\w])(?:\\.\\/)?(?:" +
    TOP_DIR_PAT +
    ")\\/[\\w./@:_+\\-]+)" +
    "|(?:(?<![./\\w])[\\w][\\w./@:_+\\-]*\\.(?:" +
    KNOWN_EXTS +
    ")\\b)",
  "g",
);

export interface Segment {
  kind: "text" | "path";
  value: string;
  /** for "path": the cleaned path to feed into rawFileUrl */
  path?: string;
}

export function splitWithPaths(input: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const match of input.matchAll(PATH_RE)) {
    const idx = match.index ?? 0;
    const raw = match[0];
    if (idx > last) out.push({ kind: "text", value: input.slice(last, idx) });
    let cleaned = raw.startsWith("`") && raw.endsWith("`") ? raw.slice(1, -1) : raw;
    cleaned = cleaned.replace(/^\.\//, "");
    if (looksLikePath(cleaned)) {
      out.push({ kind: "path", value: raw, path: cleaned });
    } else {
      out.push({ kind: "text", value: raw });
    }
    last = idx + raw.length;
  }
  if (last < input.length) out.push({ kind: "text", value: input.slice(last) });
  return out;
}

function looksLikePath(s: string): boolean {
  if (s.startsWith("/")) return false;
  if (s.startsWith("http://") || s.startsWith("https://")) return false;
  if (s.includes("://")) return false;
  if (s.length > 200) return false;
  const ext = s.split(".").pop() ?? "";
  if (TOP_DIRS.some((d) => s === d || s.startsWith(`${d}/`))) return true;
  return new RegExp(`^(?:${KNOWN_EXTS})$`).test(ext);
}
