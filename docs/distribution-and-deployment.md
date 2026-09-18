# Distribution and deployment

A deployment is an **app home**: a pnpm workspace containing a versioned harness dependency, persistent agent data, an optional product app, and deployment scripts. The harness package is installed into that home; it is not copied as a second source repository.

## Ownership and layout

```text
<app-home>/
  package.json  pnpm-workspace.yaml  pnpm-lock.yaml
  .npmrc                              registry scope, without a committed token
  config.example                      deployment parameter template
  config                              deployment-owned values, gitignored
  harness/
    package.json                      depends on the harness package
    harness.json                      timezone and data version
    .secrets/                         gitignored credentials and signing keys
    agents/                           deployment-owned agent forks
    plugins/                          optional plugin definition forks
  app/                                optional product application
    auth-routes/                      supplied authentication route templates
    artifacts-routes/                 supplied artifact route templates
  scripts/
    setup-server.sh  server.sh  build.sh
    aws/  contabo/  lib/               provisioning and shared helpers
    app/                              deployment-owned hooks
  docs/
    base-harness/                     shipped user reference
    harness/  app/                    deployment-specific documentation
```

The package owns server code, core plugins, templates, bundled console, and shipped skills. The deployment owns its agent forks, optional plugin forks, product app, configuration, and data. Plugin seed files are copied into agents on startup, so persistent changes to those files belong in the selected plugin source.

`init` creates the developer agent `nova`; its reserved name and developer overlay are handled by CLI scaffolding. Ordinary agents receive the base template and skill-creation support. The developer agent receives the full shipped skill set.

## Installation

The package manifest targets GitHub Packages. Configure the scope and an appropriate registry token before installation; do not commit token values:

```ini
@cognisphere-sh:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${COGNISPHERE_NPM_TOKEN}
```

With `COGNISPHERE_NPM_TOKEN` supplied in your shell environment:

```bash
npx @cognisphere-sh/cognisphere-harness init my-app
cd my-app
pnpm install
cd harness
pnpm exec cognisphere serve
```

The backend serves the bundled operator console on port 3142 by default. Configure real login credentials, model providers, and enabled models before using the agents. Agent startup can run the base bootstrap script to provision Pi and tool dependencies; failures are logged, so inspect them if a tool is unavailable.

## CLI

Run commands from the app-home root or its `harness/` directory using the installed `cognisphere` binary.

| Command | Effect |
|---|---|
| `init <name> [--timezone <tz>] [--root <dir>]` | Create an app home and `nova`. |
| `agent new <name> [--dev]` | Fork agent files and write starter configuration. Developer agents use the reserved name `nova`. |
| `plugin add <id>` | Fork an optional catalog definition into harness `plugins/`; core IDs cannot be forked through this command. |
| `dev [--port <n>] [--web-port <n>] [--no-web]` | Watch backend code; start Vite when the monorepo web package is available. |
| `serve [--port <n>] [--headless]` | Start the backend; optionally omit the console. |
| `upgrade` | Show the pending data migration window. |
| `upgrade --to <version>` | Change the harness package dependency. |
| `upgrade --set-version <version>` | Record a completed data migration in `harness.json`. |

The CLI resolves runtime data paths from the selected home. Source-repository development uses `pnpm dev` and `pnpm dev:web`; direct server environment defaults are listed in the [server reference](server.md#1-entrypoint-and-configuration).

## Packaging

`packages/harness` publishes TypeScript source loaded with `tsx`. Its `prepack` script builds/copies the operator console into `dist-web/`, copies the root changelog and MIT license, and bundles the shipped upgrade/plugin/skill authoring skills. Agent and app-home templates ship with the package.

Before publishing, run:

```bash
pnpm check
cd packages/harness
npm pack --dry-run --json
```

Inspect the file list for the runtime source, templates, built console, skills, changelog, and license. Publishing is a separate registry operation; this documentation does not establish whether a release has been published.

## Server deployment

The scaffold supports Ubuntu with systemd and nginx. Platform provisioning is separate from application lifecycle:

| Script | Purpose |
|---|---|
| `scripts/aws/setup.sh` | Provision AWS infrastructure and perform remote bootstrap using its platform config. |
| `scripts/contabo/setup.sh` | Provision Contabo infrastructure and perform remote bootstrap; a first run can place a paid server order. |
| `scripts/lib/remote-bootstrap.sh` | Shared remote setup used by platform scripts. |
| `scripts/setup-server.sh` | Install host prerequisites and configure users, services, nginx/TLS, and backup scheduling. |
| `scripts/build.sh` | Install dependencies and build the console/product app where present. |
| `scripts/server.sh` | Generate runtime secrets and manage deployed services. |
| `scripts/aws/backup.sh` | Backup helper; supports S3-compatible storage configuration. |

Copy each relevant `config.example` to its gitignored `config` and set deployment-specific values before running scripts. The harness runs alone until `app/package.json` exists. An optional product app must provide build/start commands, honor `PORT`, and reach the harness through its configured backend URL.

Common operations on a prepared server:

```bash
sudo ./scripts/server.sh status
sudo ./scripts/server.sh logs
sudo ./scripts/server.sh restart
sudo ./scripts/server.sh restart app
sudo ./scripts/server.sh restart harness
```

`start` and `restart` generate required secrets and build automatically. Target `app` for an app-only update. Renaming a deployment requires explicitly retiring its previous services/nginx configuration; setup is not a service-renaming migration.

Deployment secret generation writes console credentials and a persistent app-to-harness bearer secret. When the product app exists it also writes its environment and a separate app session-signing secret. The app authenticates its own users, then calls the harness from its backend. Artifact configuration can wire a shared artifact secret between the app and plugin.

App-specific hooks belong under `scripts/app/`; they are sourced by lifecycle/provisioning scripts and use the deployment config. Keep customization there so shared script updates do not overwrite it. See the shipped [hook contract](../packages/harness/home-template/scripts/app/README.md) for names and execution order.

## Upgrades

Code version and data version are separate:

1. Update the package dependency with `cognisphere upgrade --to <version>`.
2. Review the changelog window with `cognisphere upgrade`.
3. Migrate deployment-owned prompts, plugin forks, config, and data using the shipped upgrade workflow.
4. Validate the deployment, then stamp the completed migration using `--set-version`.

Keep migrations reviewable and preserve a consistent backup of runtime data. Do not stamp the data version merely because installation succeeded. Shipped `docs/base-harness/` and shared templates are refreshed by the upgrade workflow; deployment-owned agent/app changes need deliberate migration.

The proposed Process/Docker layout and SDK host are covered in the [sandbox design](design/sandbox.md) and are not part of the current deployment scripts.
