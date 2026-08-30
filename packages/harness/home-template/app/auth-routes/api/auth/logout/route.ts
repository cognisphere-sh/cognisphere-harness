import { sessionCookie } from "@/lib/auth";

export async function POST() {
  return Response.json({ ok: true }, { headers: { "set-cookie": sessionCookie(null) } });
}
