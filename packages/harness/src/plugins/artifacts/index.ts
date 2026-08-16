import { mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  Plugin,
  PluginInstanceContext,
  PluginManifest,
} from "../../core/types.js";

/**
 * artifacts — agent-authored static HTML, served on the app's domain.
 *
 * The agent writes an HTML file and runs `scripts/artifacts/artifact publish
 * <file>`; the artifact is then reachable under the app's two artifact paths:
 *
 *   public   →  https://<app>/public/artifacts/<slug>    anyone
 *   private  →  https://<app>/private/artifacts/<slug>   signed-in users only
 *
 * **The front-end app owns authentication.** `/private/artifacts/*` sits behind
 * the app's own auth gate, and the app forwards those requests here with the
 * shared `ARTIFACTS_APP_SECRET` as `X-Artifacts-Secret`. This plugin therefore
 * has exactly two rules:
 *
 *   - `/private/<slug>` (secret required) — serves ANY artifact, public or
 *     private. Reaching it means the app already authenticated the reader. No
 *     secret ⇒ 401, so the private view cannot be reached by hitting
 *     `/webhook/*` directly on either domain.
 *   - `/public/<slug>` (no secret) — serves the artifact only while it is
 *     flagged public. A private artifact is a flat 404 here.
 *
 * There are no capability tokens in URLs: a slug is the whole path, and the
 * public/private flag alone decides who may read it.
 *
 * The **share toggle lives in the app**, not in the served HTML: an artifact
 * page is sandboxed into an opaque origin (below), so the app's session cookie
 * could never travel with a request made from inside it. The app's protected
 * page renders the toggle as its own chrome and calls `POST
 * /private/<slug>/share` server-side, where its session check has already run.
 * `GET /private/<slug>/meta` gives that page the current flag and links.
 *
 * ponytail: the filesystem IS the database — `<slug>.<visibility>.html`, so the
 *   flag is the filename and a flip is one `renameSync`. Lookup is one
 *   `readdirSync` per request; add an index if a deployment ever holds
 *   thousands of artifacts.
 *
 * ponytail: one self-contained .html per artifact, no per-artifact asset
 *   directories. An artifact may reference external URLs (CDN css, image hosts)
 *   or inline assets as `data:` URIs. Add directory-artifacts + a mime map when
 *   one genuinely needs to ship its own binary assets.
 *
 * Served HTML is agent-authored and sits on the app's own origin, so it is sent
 * with `Content-Security-Policy: sandbox` (no `allow-same-origin`): the artifact
 * runs in an opaque origin and cannot touch the app's cookies, storage or
 * same-origin APIs — which is what makes it safe to host agent output on the
 * same domain as a logged-in app.
 */

/** Slug charset. Doubles as the path-traversal guard — nothing that fails
 *  this regex is ever compared against a filename. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** `<slug>.<visibility>.html` */
const FILE_RE = /^([a-z0-9][a-z0-9-]{0,63})\.(public|private)\.html$/;

type Visibility = "public" | "private";

interface ArtifactsConfig {
  appBaseUrl: string;
}

interface Entry {
  slug: string;
  visibility: Visibility;
  file: string;
}

interface ArtifactInfo {
  slug: string;
  visibility: Visibility;
  /** The link to hand out: the public one while public, else the private one. */
  url: string;
  /** The signed-in view. Always valid, whatever the flag says. */
  privateUrl: string;
  bytes: number;
  modified: string;
}

export default class ArtifactsPlugin implements Plugin {
  manifest: PluginManifest = {
    displayName: "Artifacts",
    description:
      "Hosts agent-authored static HTML artifacts (reports, summaries, dashboards) on the app's domain: public ones at /public/artifacts/<slug>, private ones at /private/artifacts/<slug> behind the app's own login. Each artifact carries a public/private flag that the agent, or a signed-in reader, can flip.",
    configSchema: {
      type: "object",
      properties: {
        appBaseUrl: {
          type: "string",
          description:
            "Origin of the front-end app that serves the artifact routes, no trailing slash — e.g. `https://carguy.cognisphere.sh`. Shared links are built as `<appBaseUrl>/public/artifacts/<slug>` and `<appBaseUrl>/private/artifacts/<slug>`; the app must route both to this plugin (see the app template's artifacts-routes/README.md).",
        },
      },
      required: ["appBaseUrl"],
      additionalProperties: false,
    },
    secretsSchema: {
      type: "object",
      properties: {
        ARTIFACTS_APP_SECRET: {
          type: "string",
          description:
            "Shared secret the app sends as `X-Artifacts-Secret` on private-artifact requests, after it has authenticated the reader. Without it the private view is unreachable — that is what keeps private artifacts off the open /webhook/* surface.",
        },
      },
      required: ["ARTIFACTS_APP_SECRET"],
      additionalProperties: false,
    },
  };

  private ctx?: PluginInstanceContext;
  private dir = "";

  async start(ctx: PluginInstanceContext): Promise<void> {
    this.ctx = ctx;
    this.dir = ctx.stateDir;
    mkdirSync(this.dir, { recursive: true });
    ctx.log.info({ base: this.base() }, "artifacts started");
  }

  async stop(): Promise<void> {
    this.ctx = undefined;
  }

  /** App origin every shared link is built from. */
  private base(): string {
    return (this.ctx?.config as ArtifactsConfig).appBaseUrl.replace(/\/+$/, "");
  }

  private entries(): Entry[] {
    return readdirSync(this.dir).flatMap((name) => {
      const m = FILE_RE.exec(name);
      return m
        ? [
            {
              slug: m[1] as string,
              visibility: m[2] as Visibility,
              file: join(this.dir, name),
            },
          ]
        : [];
    });
  }

  private find(slug: string): Entry | undefined {
    return this.entries().find((e) => e.slug === slug);
  }

  private info(e: Entry): ArtifactInfo {
    const base = this.base();
    const st = statSync(e.file);
    return {
      slug: e.slug,
      visibility: e.visibility,
      url: `${base}/${e.visibility}/artifacts/${e.slug}`,
      privateUrl: `${base}/private/artifacts/${e.slug}`,
      bytes: st.size,
      modified: new Date(st.mtimeMs).toISOString(),
    };
  }

  async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) {
      res.writeHead(503, { "content-type": "text/plain" }).end("not started");
      return;
    }
    const url = new URL(req.url || "/", "http://local");
    const [scope, slug, verb, ...rest] = url.pathname
      .split("/")
      .filter((s) => s.length > 0);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const text = (code: number, body: string) => {
      res.writeHead(code, { "content-type": "text/plain" }).end(body);
    };

    // Agent-facing listing, read by `scripts/artifacts/artifact`. Insider-only,
    // same shared-secret scheme as agent-messaging — see docs/api.md §10.
    if (req.method === "GET" && scope === "api" && slug === "list" && !verb) {
      const expected = process.env.COGNISPHERE_WEBHOOK_SECRET;
      if (expected && req.headers["x-webhook-secret"] !== expected) {
        return json(401, { error: "missing or invalid X-Webhook-Secret" });
      }
      return json(
        200,
        this.entries()
          .sort((a, b) => a.slug.localeCompare(b.slug))
          .map((e) => this.info(e)),
      );
    }

    if (rest.length || !slug || !SLUG_RE.test(slug)) return text(404, "not found");
    if (scope !== "public" && scope !== "private") return text(404, "not found");

    // Everything under /private/* is the app vouching for a signed-in reader.
    const signedIn = scope === "private";
    if (signedIn && req.headers["x-artifacts-secret"] !== ctx.secrets.ARTIFACTS_APP_SECRET) {
      return text(401, "not authorized");
    }
    const e = this.find(slug);
    if (!e || (!signedIn && e.visibility !== "public")) return text(404, "not found");

    // The app's protected page reads this to render its share toggle, and
    // POSTs back here to flip the flag. Both are server-side calls it makes
    // after its own auth gate has run.
    if (signedIn && verb === "meta" && req.method === "GET") {
      return json(200, this.info(e));
    }
    if (signedIn && verb === "share" && req.method === "POST") {
      const body = (await readJson(req)) as { public?: unknown };
      const next: Visibility = body.public === true ? "public" : "private";
      if (next !== e.visibility) {
        renameSync(e.file, join(this.dir, `${slug}.${next}.html`));
        ctx.log.info({ slug, visibility: next }, "artifact visibility changed");
      }
      const updated = this.find(slug);
      return json(200, updated ? this.info(updated) : { error: "gone" });
    }
    if (verb) return text(404, "not found");
    if (req.method !== "GET") return text(405, "GET only");

    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // Opaque origin: agent-authored HTML on the app's domain must not reach
      // the app's cookies/storage. No `allow-same-origin` — ever.
      "content-security-policy":
        "sandbox allow-scripts allow-forms allow-popups allow-downloads",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      // A private artifact must never be held by a shared cache in front of
      // the app; a public one is safe to cache briefly.
      "cache-control": signedIn ? "private, no-store" : "public, max-age=60",
    });
    res.end(withViewport(await readFile(e.file, "utf8")));
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = "";
  for await (const c of req) s += c;
  try {
    return s ? (JSON.parse(s) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Every artifact must render on a phone, and a page without this meta tag
 * cannot — no CSS makes up for it. Authors are told to include it; this makes
 * it true even when they forget.
 */
function withViewport(html: string): string {
  if (/<meta[^>]+name=["']?viewport/i.test(html)) return html;
  return `<meta name="viewport" content="width=device-width, initial-scale=1">\n${html}`;
}
