/**
 * Shared helpers for the artifact routes. Copy to `app/lib/artifacts.ts`.
 *
 * Env (all read server-side only — none of this reaches the browser):
 *   HARNESS_URL             http://127.0.0.1:<HARNESS_PORT>   (already written by scripts/server.sh secrets)
 *   ARTIFACTS_AGENT         the agent that publishes artifacts, e.g. `lexi`
 *   ARTIFACTS_APP_SECRET    same value as the agent's plugin secret
 *   ARTIFACTS_SESSION_COOKIE  name of your session cookie (see `signedIn`)
 */
const HARNESS = process.env.HARNESS_URL ?? "http://127.0.0.1:3142";

export interface ArtifactInfo {
  slug: string;
  visibility: "public" | "private";
  url: string;
  privateUrl: string;
  bytes: number;
  modified: string;
}

/** The plugin endpoint behind one of the app's artifact paths. */
export function artifactUpstream(scope: "public" | "private", slug: string): string {
  const agent = process.env.ARTIFACTS_AGENT ?? "";
  return `${HARNESS}/webhook/${agent}/artifacts/${scope}/${encodeURIComponent(slug)}`;
}

function secretHeader(): Record<string, string> {
  return { "x-artifacts-secret": process.env.ARTIFACTS_APP_SECRET ?? "" };
}

/**
 * The app's auth gate for artifact routes.
 *
 * REPLACE THIS with your app's real session validation. Cookie *presence* is
 * not proof of a valid session — this is a fail-closed second layer behind the
 * gate that actually authenticates (your middleware / `proxy.ts`), not a
 * substitute for it. With ARTIFACTS_SESSION_COOKIE unset, nothing private is
 * served at all.
 */
export function signedIn(req: Request): boolean {
  const name = process.env.ARTIFACTS_SESSION_COOKIE;
  if (!name) return false;
  return (req.headers.get("cookie") ?? "")
    .split(/;\s*/)
    .some((c) => c.startsWith(`${name}=`));
}

/** Current flag + links for one artifact; null when it doesn't exist. */
export async function artifactMeta(slug: string): Promise<ArtifactInfo | null> {
  const r = await fetch(`${artifactUpstream("private", slug)}/meta`, {
    headers: secretHeader(),
    cache: "no-store",
  });
  return r.ok ? ((await r.json()) as ArtifactInfo) : null;
}

/** Fetch an artifact's HTML with the secret attached (private view). */
export function fetchPrivateHtml(slug: string): Promise<Response> {
  return fetch(artifactUpstream("private", slug), {
    headers: secretHeader(),
    cache: "no-store",
  });
}

/**
 * Relay the harness's HTML response verbatim. The security headers MUST survive
 * the hop: the CSP sandbox is what stops agent-authored HTML from touching this
 * app's cookies and storage.
 */
export async function passThroughHtml(upstream: Response): Promise<Response> {
  const keep = [
    "content-type",
    "content-security-policy",
    "referrer-policy",
    "x-content-type-options",
    "cache-control",
  ];
  const headers = new Headers();
  for (const h of keep) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers,
  });
}
