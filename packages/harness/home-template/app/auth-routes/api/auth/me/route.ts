import { getUser } from "@/lib/auth";

export async function GET(req: Request) {
  return Response.json({ user: await getUser(req) });
}
