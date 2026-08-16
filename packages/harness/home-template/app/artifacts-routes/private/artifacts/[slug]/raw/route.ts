/**
 * GET /private/artifacts/<slug>/raw — the artifact's HTML, for the iframe on
 * the protected page. Adds the shared secret, which is what lets the harness
 * serve a private artifact at all.
 *
 * PROTECTED: this path must sit inside the app's auth gate (see the README).
 */
import { fetchPrivateHtml, passThroughHtml, signedIn } from "@/lib/artifacts";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  if (!signedIn(req)) return new Response("sign in", { status: 401 });
  const { slug } = await params;
  return passThroughHtml(await fetchPrivateHtml(slug));
}
