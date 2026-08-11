# scripts/app/ — deployment-owned deploy hooks

Everything in this directory **except this README** belongs to your deployment.
Harness upgrades refresh the harness-owned scripts (`../setup-server.sh`,
`../server.sh`, `../build.sh`, `../aws/`, `../contabo/`, and this README) —
they never touch your hooks. Put every app-specific deploy customization here
instead of editing the harness-owned scripts, so an upgrade stays a clean copy
with no hand-merge.

Each hook is optional. When present it is **sourced** (not exec'd) at a fixed
point, so it sees everything the caller has — the sourced root `config` plus
the caller's resolved variables (`$ROOT`, etc.) — and runs under
`set -euo pipefail`: a failing hook aborts the caller.

| Hook | Sourced by | When / as whom | Typical use |
|---|---|---|---|
| `secrets.sh` | `../server.sh` (`gen_secrets`) | after the stock secrets are written — on every `secrets`, `start`, `restart`, `dev`; as the invoking user | write extra `harness/.secrets/secrets.json` buckets, plugin `config.json`s, extra `app/.env.local` lines. The resolved operator login is in `harness/.secrets/users.json`. |
| `server.sh` | `../server.sh` | after every stock action except the foreground/exec ones (`harness`, `dev`, `logs`); same user as the caller | app lifecycle work — case on `"$1"` (`start`, `restart`, `stop`, `status`, `build`, `secrets`; `$2` = optional `app`\|`harness` target): run migrations on restart, bounce extra services, … |
| `setup-server.sh` | `../setup-server.sh` | end of server provisioning, as root | extra apt packages, nginx tweaks (run `nginx -t && systemctl reload nginx` yourself), extra units/crons |
| `aws-setup.sh` | `../aws/setup.sh` | end of AWS provisioning, locally | extra buckets / IAM grants — add your own `aws iam put-role-policy` under a distinct policy name rather than editing the stock one; `$ROLE`, `$S3_BUCKET`, `$INSTANCE_ID`, `$IP` are set |
| `contabo-setup.sh` | `../contabo/setup.sh` | end of Contabo provisioning, locally | same idea for Contabo; `$INSTANCE_ID`, `$IP`, `$BUCKET` are set |

## Extra config params

The root `config` (and `scripts/<platform>/config`) are already
deployment-owned — add your app's keys there and read them from your hooks.
Document them in a `config.example` **in this directory**: the root
`../../config.example` is harness-owned and refreshed on upgrade, so app keys
documented there would be lost. Fresh-clone setup then is:

```bash
cp config.example config && cat scripts/app/config.example >> config
```
