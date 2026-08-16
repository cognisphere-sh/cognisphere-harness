/**
 * GET /public/artifacts/<slug> — a published artifact, open to anyone.
 *
 * Straight pass-through to the harness's `artifacts` plugin. No secret: the
 * plugin serves this path only while the artifact is flagged public, and 404s
 * for a private one. Keep this path OUT of the app's auth gate.
 */
import { artifactUpstream, passThroughHtml } from "@/lib/artifacts";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  return passThroughHtml(await fetch(artifactUpstream("public", slug)));
}
