---
name: cognisphere-deploy
description: Deploy a CogniSphere harness to a host (provision a data dir, install the package, configure secrets/models, run under systemd behind a reverse proxy). Use when asked to "deploy the harness", "set up cognisphere on the server", "provision a new harness", or "run cognisphere in production".
metadata:
  author: cognisphere
  version: "1.0.0"
  argument-hint: <harness-id>
---

# CogniSphere Deploy

Stand up a harness on a host. The model: **install the code once as a versioned
dependency, point a data dir at it** (`docs/distribution-and-deployment.md` §2,
§8). One harness = one data dir = one process = one port behind the proxy.

> A new product is often a new **agent**, not a new **harness**. Reach for a new
> harness only when you need isolation: separate secrets, separate version, or a
> separate public URL.

## Prerequisites

- Host with Node ≥ 20, `pnpm`, and (for `cognisphere up`) **systemd user**
  services enabled (`loginctl enable-linger $USER`).
- Registry auth: a `GITHUB_TOKEN` with `read:packages` exported in the
  environment (the generated `.npmrc` reads it).
- A reverse proxy (Caddy assumed below) terminating TLS.

## Procedure

### 1. Scaffold + install

```bash
export GITHUB_TOKEN=<read:packages token>
npx @cognisphere/cognisphere-harness init <harness-id>     # ~/.cognisphere/<harness-id>
cd ~/.cognisphere/<harness-id>
pnpm install                                               # pins code via lockfile
```

`init` writes `harness.json` (`{version, timezone}`), a `.secrets/` dir with a
generated `session-key` (0600), `package.json`, `.npmrc`, `.gitignore`, and an
empty `agents/` + `plugins/`. The dir is a git repo — commit it (excluding
`.secrets/`, which `.gitignore` already excludes).

### 2. Agents + plugins

```bash
cognisphere agent new <name>          # fork the base template
cognisphere plugin add <id>           # (optional) fork a catalog plugin
```

Edit `agents/<name>/agent.json` (model/provider, thread strategy) and the
`system_prompts/`.

### 3. Secrets & models (never committed)

Under `.secrets/` (mode 0600 — **do not loosen perms or commit**):

- `models.json` — provider credentials (set via the Models settings UI or by
  hand). The agent stays `failed` until its model provider is configured.
- `secrets.json` — per-agent / per-plugin secrets (telegram tokens, OAuth, etc.),
  shaped `{ <agentId>: { agent: {...}, <pluginId>: {...} } }`.
- `users.json` — operator login(s) for the web console.

Verify perms: `ls -l .secrets` → files `-rw-------`, dir `drwx------`.

### 4. Choose a port + run under systemd

Pick a free port (each harness needs its own). Set it for the service — either
export `PORT` in the unit's environment or front it with the proxy on a fixed
internal port. Then:

```bash
cognisphere up <harness-id>           # installs the cognisphere@.service template,
                                      # enables + starts cognisphere@<harness-id>
cognisphere status <harness-id>
cognisphere logs <harness-id> -f
```

`up` writes `~/.config/systemd/user/cognisphere@.service` (WorkingDirectory
`~/.cognisphere/%i`, ExecStart `… node_modules/.bin/cognisphere serve`). For a
non-default `PORT` or `COGNISPHERE_ROOT_DIR`, add `Environment=` lines to that
unit and `--reinstall` is not needed for env-only edits — just
`systemctl --user daemon-reload && systemctl --user restart cognisphere@<id>`.

### 5. Reverse proxy (Caddy)

Route the harness's public hostname to its bound port (default `127.0.0.1:7331`):

```caddy
harness.example.com {
    reverse_proxy 127.0.0.1:7331
}
```

Reload Caddy. For multiple harnesses, add one block per hostname → per-harness
port.

### 6. Verify

```bash
curl -sf http://127.0.0.1:<port>/healthz          # → {"ok":true,"agents":N}
```

Then load the web console over the public URL, log in (from `users.json`), and
confirm each agent is `running` (or shows the expected "configure provider"
state until models are set).

## Adding another harness later

Repeat steps 1–6 with a new id and a new port. pnpm's content-addressed store
hard-links shared deps, so N harnesses on the same version cost ~one copy on
disk while staying version-isolated.

## Upgrades

To move a deployed harness to a new version, use the **`cognisphere-upgrade`**
skill (two-phase: bump the dependency, then migrate the data dir).
