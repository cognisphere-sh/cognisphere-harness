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
