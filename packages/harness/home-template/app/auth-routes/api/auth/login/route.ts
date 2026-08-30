import { createSession, sessionCookie, verifyCredentials } from "@/lib/auth";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { username?: string; password?: string };
  const user = body.username && body.password ? verifyCredentials(body.username, body.password) : null;
  if (!user) return Response.json({ error: "invalid credentials" }, { status: 401 });
  return Response.json({ ok: true, user }, { headers: { "set-cookie": sessionCookie(createSession(user)) } });
}
