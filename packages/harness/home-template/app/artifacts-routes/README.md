# Artifact routes — public and protected pages

Drop-in routes that put the harness's `artifacts` plugin on this app's domain.
The **app owns authentication**; the harness only distinguishes "the app
vouched for this reader" (a shared secret) from "anyone".

```
https://<your-domain>/public/artifacts/<slug>    open to anyone, only while the artifact is flagged public
https://<your-domain>/private/artifacts/<slug>   signed-in users only; carries the public/private toggle
```

No tokens, ever: the slug is the whole URL and the artifact's flag decides who
may read it. Flipping the flag changes which of the two links works — the
private link always works for signed-in users.

## Install

1. Copy the tree into your Next app (paths are relative to `app/`):

   ```
   artifacts-routes/lib/artifacts.ts                     → app/lib/artifacts.ts
   artifacts-routes/public/artifacts/[slug]/route.ts     → app/app/public/artifacts/[slug]/route.ts
   artifacts-routes/private/artifacts/[slug]/*           → app/app/private/artifacts/[slug]/*
   ```

   The imports use the `@/*` alias that `create-next-app` sets up; adjust if
   your app doesn't have it.

2. **Gate `/private/*` and leave `/public/*` open.** In `proxy.ts` (or
   `middleware.ts`), `/private` must NOT be in the public-prefix list, and
   `/public` must be — the private routes also check `signedIn()` themselves,
   but your gate is what redirects a logged-out visitor to the login page.

3. Fill in `signedIn()` in `lib/artifacts.ts` with your app's real session
   validation. The shipped version only checks that
   `$ARTIFACTS_SESSION_COOKIE` is present and **fails closed when that env var
   is unset**, so nothing private is served until you wire it.

4. Set the env (`app/.env.local`; `HARNESS_URL` is already written by
   `scripts/server.sh secrets`):

   ```
   ARTIFACTS_AGENT=lexi
   ARTIFACTS_APP_SECRET=<same value as the plugin secret>
   ARTIFACTS_SESSION_COOKIE=<your session cookie name>
   ```

5. On the harness side, enable the plugin for that agent and point it back here:

   ```bash
   mkdir -p harness/agents/lexi/plugins/artifacts
   echo '{"appBaseUrl":"https://carguy.cognisphere.sh"}' \
     > harness/agents/lexi/plugins/artifacts/config.json
   # harness/.secrets/secrets.json → { "lexi": { "artifacts": { "ARTIFACTS_APP_SECRET": "…" } } }
   ```

   Restart the agent so the config, the secret and the agent's seeded
   `scripts/artifacts/` + `publish-artifact` skill land.

## How it fits together

| Route | Auth | What it does |
|---|---|---|
| `GET /public/artifacts/<slug>` | none | Pass-through to the plugin's `public/<slug>`. 404 while the artifact is private. |
| `GET /private/artifacts/<slug>` | app gate | Server component: reads the flag, renders the toggle, embeds the artifact in a sandboxed iframe. |
| `GET /private/artifacts/<slug>/raw` | app gate | The artifact HTML, fetched with the shared secret. |
| `POST /private/artifacts/<slug>/share` | app gate | `{"public":bool}` → flips the flag. |

The artifact HTML always arrives with `Content-Security-Policy: sandbox` (no
`allow-same-origin`), and `passThroughHtml` deliberately preserves that header:
it is what stops agent-authored HTML from reading this app's cookies, storage
or same-origin APIs while sitting on the same domain. That is also why the
toggle is app chrome around an iframe rather than a control injected into the
artifact — a sandboxed document has an opaque origin and could never
authenticate to this app.

## Multiple publishing agents

`ARTIFACTS_AGENT` binds these routes to one agent. For a second one, copy the
tree under a distinct prefix (e.g. `/public/reports/<slug>`) pointed at that
agent, and set its plugin `appBaseUrl` to match.
