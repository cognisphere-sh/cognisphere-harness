import { accessSync, constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Logger } from "./logger.js";

/**
 * Agent-owned message routing. The router is the only thing that decides
 * which thread a message goes to.
 *
 * Every message a plugin hands the runner (`notify`) goes through the agent's
 * router, `workspace/router.ts`, which returns one or more thread ids. When it
 * returns nothing, the thread is the message's `metadata.threadId` (set by a
 * plugin that targets a thread, such as agent-messaging or the console), or
 * `main`. A thread id `workflow:<name>` is a workflow: a static script in
 * `workspace/workflows/<name>/` that a worker runs once per queued message.
 *
 * The router runs in the harness process and must be synchronous, so a message
 * is in the queue the moment `notify` returns. It is reloaded when its file or
 * the workflows change; a reload that fails keeps the last good router.
 */

/** What the router sees. */
export interface RouterMessage {
  notification: string;
  pluginId: string;
  channelId: string;
  text: string;
  metadata: Record<string, unknown>;
  isSilent: boolean;
}

export interface WorkflowInfo {
  name: string;
  description: string;
}

export type RouteFn = (
  msg: RouterMessage,
  workflows: WorkflowInfo[],
) => string | string[] | null | undefined | void;

export interface Workflow extends WorkflowInfo {
  /** Absolute path of the script to run. */
  script: string;
}

export interface Routing {
  route: RouteFn | null;
  workflows: Map<string, Workflow>;
  /** Set when `router.ts` exists but failed to load. */
  error?: string;
}

export const ROUTER_FILE = join("workspace", "router.ts");
export const WORKFLOWS_DIR = join("workspace", "workflows");
export const DEFAULT_THREAD = "main";
export const WORKFLOW_PREFIX = "workflow:";

/** The base agent's starter router and workflows folder. */
const BASE_WORKSPACE = fileURLToPath(new URL("../agents/base-agent/workspace", import.meta.url));

/** Give an agent the starter router and workflows README if it has none
 *  (agents created before routing existed). Never overwrites; a failure is
 *  logged, not thrown. */
export function seedRouting(agentDir: string, log: Logger): void {
  for (const rel of ["router.ts", join("workflows", "README.md")]) {
    const dest = join(agentDir, "workspace", rel);
    try {
      if (existsSync(dest)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(BASE_WORKSPACE, rel), dest);
    } catch (err) {
      log.error({ err, dest }, "could not seed routing file");
    }
  }
}

/** The workflow a thread id names (`workflow:<name>` → `<name>`), if any. */
export function workflowName(threadId: string): string | undefined {
  return threadId.startsWith(WORKFLOW_PREFIX) ? threadId.slice(WORKFLOW_PREFIX.length) : undefined;
}

/** Directory entries, or none if it is missing or unreadable. */
function listDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Load the router and workflows of an agent. Never throws. A workflow with a
 * bad `workflow.json` or a script that isn't executable is skipped (and
 * logged).
 */
export async function loadRouting(agentDir: string, log: Logger): Promise<Routing> {
  const workflows = new Map<string, Workflow>();
  const wfRoot = join(agentDir, WORKFLOWS_DIR);
  for (const entry of listDir(wfRoot)) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(wfRoot, entry.name);
    try {
      const spec = JSON.parse(readFileSync(join(dir, "workflow.json"), "utf8")) as Record<
        string,
        unknown
      >;
      const description = typeof spec.description === "string" ? spec.description.trim() : "";
      if (!description) throw new Error("workflow.json needs a description");
      if (typeof spec.script !== "string" || !spec.script) {
        throw new Error("workflow.json needs a script");
      }
      const script = join(dir, spec.script);
      try {
        accessSync(script, constants.X_OK);
      } catch {
        throw new Error(`script missing or not executable (chmod +x): ${spec.script}`);
      }
      workflows.set(entry.name, { name: entry.name, description, script });
    } catch (err) {
      log.error({ err, workflow: entry.name }, "workflow skipped");
    }
  }

  let route: RouteFn | null = null;
  let error: string | undefined;
  const file = join(agentDir, ROUTER_FILE);
  if (existsSync(file)) {
    try {
      // The harness process outlives every reload; the mtime query makes an
      // edited router load fresh instead of from the module cache.
      const url = `${pathToFileURL(file).href}?v=${statSync(file).mtimeMs}`;
      const mod = (await import(url)) as { default?: unknown };
      if (typeof mod.default !== "function") throw new Error("router.ts has no default export function");
      route = mod.default as RouteFn;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      log.error({ err, file }, "router failed to load");
    }
  }
  log.info({ router: route !== null, workflows: [...workflows.keys()] }, "routing loaded");
  return { route, workflows, ...(error ? { error } : {}) };
}

/** A cheap fingerprint of everything `loadRouting` reads, to detect edits. */
function routingStamp(agentDir: string): string {
  const parts: string[] = [];
  const stamp = (p: string) => {
    try {
      const s = statSync(p);
      parts.push(`${p}:${s.mtimeMs}:${s.mode}`);
    } catch {
      parts.push(`${p}:-`);
    }
  };
  stamp(join(agentDir, ROUTER_FILE));
  const wfRoot = join(agentDir, WORKFLOWS_DIR);
  stamp(wfRoot);
  for (const d of listDir(wfRoot)) {
    if (!d.isDirectory()) continue;
    stamp(join(wfRoot, d.name));
    for (const f of listDir(join(wfRoot, d.name))) stamp(join(wfRoot, d.name, f.name));
  }
  return parts.join("|");
}

/**
 * Re-load routing whenever the router or a workflow changes, so the agent's
 * own edits apply within `intervalMs`. A router that fails to reload keeps the
 * previous router function (the new workflow list still applies). Returns a
 * stop function.
 */
export function watchRouting(
  agentDir: string,
  initial: Routing,
  apply: (r: Routing) => void,
  log: Logger,
  intervalMs = 2000,
): () => void {
  let current = initial;
  let last = routingStamp(agentDir);
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    const now = routingStamp(agentDir);
    if (now === last) return;
    last = now;
    busy = true;
    void loadRouting(agentDir, log)
      .then((next) => {
        if (next.error && current.route) {
          log.error({ error: next.error }, "router reload failed; keeping the previous router");
          next = { ...next, route: current.route };
        }
        current = next;
        apply(next);
      })
      .catch((err: unknown) => log.error({ err }, "routing reload failed; keeping current routing"))
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** Why a thread id can't be used, or null. Thread ids double as folder names
 *  (`sessions/<threadId>/`), and `workflow:` ids must name a loaded workflow. */
function badThreadId(id: string, routing: Routing | undefined): string | null {
  // Same rule as the API's `isSafeId`, so every queued thread stays readable.
  if (!id.trim()) return "empty thread id";
  if (id.length > 256 || id.startsWith(".") || /[/\\\0]/.test(id)) return `unsafe thread id: ${id}`;
  const wf = workflowName(id);
  if (wf !== undefined && !routing?.workflows.has(wf)) return `unknown workflow: ${wf}`;
  return null;
}

/**
 * The threads a message goes to. Never throws. When the router is absent,
 * returns nothing, throws or returns only invalid ids, the thread is
 * `metadata.threadId` if valid, else `main`. An explicit `[]` drops it.
 */
export function resolveThreads(routing: Routing | undefined, msg: RouterMessage, log: Logger): string[] {
  const published = msg.metadata.threadId;
  let fallback = DEFAULT_THREAD;
  if (typeof published === "string" && published) {
    const bad = badThreadId(published, routing);
    if (bad) log.error({ reason: bad }, "metadata.threadId rejected; using main");
    else fallback = published;
  }
  if (!routing?.route) return [fallback];

  let out: ReturnType<RouteFn>;
  try {
    const infos = [...routing.workflows.values()].map(({ name, description }) => ({
      name,
      description,
    }));
    out = routing.route(msg, infos);
  } catch (err) {
    log.error({ err, fallback }, "router threw; using fallback thread");
    return [fallback];
  }
  if (out == null) return [fallback];
  const ids = Array.isArray(out) ? out : [out];
  if (ids.length === 0) {
    log.info({ plugin: msg.pluginId, notification: msg.notification }, "router dropped message");
    return [];
  }

  const valid: string[] = [];
  for (const id of ids as unknown[]) {
    const bad = typeof id === "string" ? badThreadId(id, routing) : "not a string";
    if (bad) log.error({ route: id, reason: bad }, "router returned an invalid thread id");
    else if (!valid.includes(id as string)) valid.push(id as string);
  }
  return valid.length > 0 ? valid : [fallback];
}
