# app/ — the user-facing app

This directory holds the product's user-facing web app (a Next.js app is the
convention). The deploy scripts under `../scripts/` pick it up automatically
once an `app/package.json` exists; until then they run the harness alone.

Contract with the deploy scripts:

- **`build` / `start` scripts** must exist in `app/package.json`
  (`scripts/build.sh` runs the build; the `<name>-app.service` systemd unit
  runs `pnpm start` from this directory).
- **Honor `PORT`** (set to `APP_PORT` from `../config`). With Next.js,
  `next start` reads it natively.
- **Reach the harness at `HARNESS_URL`** (`http://127.0.0.1:<HARNESS_PORT>`).
  `scripts/server.sh secrets` writes `app/.env.local` with `HARNESS_USER`,
  `HARNESS_PASS`, `HARNESS_URL`, `DOMAIN`, and `PORT` from `../config`.
- **Proxy `/api/*`** (and `/webhook/*` if the app fronts plugin webhooks)
  same-origin to `HARNESS_URL` — with Next.js, `rewrites()` in
  `next.config.ts`. No separate BFF needed.

In production, nginx serves the app on `$DOMAIN` and the harness operator
console on `$CONSOLE_DOMAIN` (see `scripts/setup-server.sh`).

## `artifacts-routes/` — public and protected artifact pages

Drop-in routes for the harness's `artifacts` plugin: `/public/artifacts/<slug>`
(open to anyone) and `/private/artifacts/<slug>` (behind this app's auth gate,
carrying the public/private toggle). They are reference code, not part of the
build — copy the tree into your app and set the env, as described in
[`artifacts-routes/README.md`](artifacts-routes/README.md). Not using the
`artifacts` plugin? Delete the directory.

## Google sign-in button (gws)

The per-agent Google sign-in normally lives on the harness console (the gws
plugin card on the agent's Settings tab), but this app can host the same
button. The harness's OAuth callback is public and authenticated by a
single-use `state` nonce, so the flow works from this origin — `/api/*` is
already proxied to the harness (see the contract above).

Server-side route handler (never expose `HARNESS_USER`/`HARNESS_PASS` to the
browser):

```ts
// app/api/google-signin/route.ts
export async function GET(req: Request) {
  const harness = process.env.HARNESS_URL!;
  const origin = new URL(req.url).origin;
  // 1. log in to the harness with the credentials from .env.local
  const login = await fetch(`${harness}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: process.env.HARNESS_USER,
      password: process.env.HARNESS_PASS,
    }),
  });
  const cookie = login.headers.get("set-cookie") ?? "";
  // 2. start the sign-in; returnTo is where the user lands afterwards
  const start = await fetch(`${harness}/api/gws/oauth/<agentId>/start`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      redirectUri: `${origin}/api/gws/oauth/callback`,
      returnTo: "/settings",
    }),
  });
  const { url } = (await start.json()) as { url: string };
  // 3. send the browser to Google's consent screen
  return Response.redirect(url, 302);
}
```

Register `https://<app domain>/api/gws/oauth/callback` as an additional
authorized redirect URI on the Google OAuth client (alongside the console
origin's). Google redirects the browser back to that path, the `/api/*`
proxy hands it to the harness, and the user lands on `returnTo` with
`?gws=signed-in` (or `?gwsError=<message>`) appended.
