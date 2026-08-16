/**
 * POST /private/artifacts/<slug>/share — flip an artifact between public and
 * private. Body: `{"public": true|false}`.
 *
 * This is the one route that changes who can read an artifact, so the session
 * check is explicit here as well as in the app's gate. The browser call is
 * same-origin from the protected page, so the session cookie travels normally;
 * the shared secret is added here, server-side, and never reaches the client.
 */
import { artifactUpstream, signedIn } from "@/lib/artifacts";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  if (!signedIn(req)) return new Response("sign in", { status: 401 });
  const { slug } = await params;
  const body = (await req.json().catch(() => ({}))) as { public?: unknown };
  const upstream = await fetch(`${artifactUpstream("private", slug)}/share`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-artifacts-secret": process.env.ARTIFACTS_APP_SECRET ?? "",
    },
    body: JSON.stringify({ public: body.public === true }),
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
