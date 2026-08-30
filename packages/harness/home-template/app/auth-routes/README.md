# Auth routes — app-owned sign-in, harness-independent

Drop-in auth for this app. By default it is a single username/password from
`../config` (`APP_USER`/`APP_PASS`) and an **app-minted** signed cookie
(`app_sid`). The harness console keeps its own `pi_sid`; the two never share a
token. The app talks to the harness server-to-server with
`Authorization: Bearer $HARNESS_APP_SECRET` + `X-App-User` (`lib/harness.ts`).

## Install

1. Copy the tree into your Next app (paths relative to `app/`):

   ```
   auth-routes/lib/auth.ts              → app/lib/auth.ts
   auth-routes/lib/harness.ts           → app/lib/harness.ts
   auth-routes/api/auth/*/route.ts      → app/app/api/auth/*/route.ts
   auth-routes/login/page.tsx           → app/app/login/page.tsx
   ```

   Do **not** rewrite `/api/auth/*` to the harness in `next.config.ts` —
   these routes replace that.

2. Gate every non-public path in `proxy.ts` (Next 16; `middleware.ts` before):

   ```ts
   import { NextResponse, type NextRequest } from "next/server";
   import { getUser } from "@/lib/auth";

   const PUBLIC = ["/login", "/api/auth", "/public"];

   export async function proxy(req: NextRequest) {
     const { pathname } = req.nextUrl;
     if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"))) return;
     if (await getUser(req)) return;
     if (pathname.startsWith("/api/")) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
     return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(pathname)}`, req.url));
   }
   ```

3. Env — all written to `app/.env.local` by `scripts/server.sh secrets`:
   `APP_USER`, `APP_PASS`, `APP_SESSION_SECRET` (generated once, reused),
   `HARNESS_APP_SECRET`, `HARNESS_URL`. Using `artifacts-routes/`? Set
   `ARTIFACTS_SESSION_COOKIE=app_sid` in `config`.

## Calling the harness

From a gated route handler only:

```ts
const user = await getUser(req);
if (!user) return new Response(null, { status: 401 });
const r = await harness("/api/agents", user);
```

The bearer has full operator access; the app's route handlers are the
authorization layer — allowlist paths, never proxy `/api/*` wholesale.

Plugins that serve this app over `/webhook/<agent>/<plugin>/*` verify the same
headers by forwarding `authorization` + `x-app-user` to
`${HARNESS_URL}/api/auth/me` (`{ user }` or `{ user: null }`).

## Switching to Clerk / Supabase Auth / NextAuth

`getUser(req)` in `lib/auth.ts` is the only seam. Replace its body with the
provider's server-side session lookup (e.g. Clerk `auth()`, Supabase
`getUser()`), returning the provider's user id, and delete
`verifyCredentials`, `createSession`, `sessionCookie`, the three
`api/auth/*` routes, and `login/page.tsx`. `proxy.ts` and `lib/harness.ts`
are unchanged — the harness never learns which provider you use.
