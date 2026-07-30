---
name: cognisphere-upgrade
description: Migrate a CogniSphere harness data dir to a newer harness version. Use when asked to "upgrade the harness", "run cognisphere upgrade", "migrate my agents to the new version", or after bumping the @cognisphere-sh/cognisphere-harness dependency.
metadata:
  author: cognisphere
  version: "1.0.0"
  argument-hint: <target-version (optional)>
---

# CogniSphere Upgrade

Drive the **two-phase upgrade** (see `docs/distribution-and-deployment.md` §9):

1. **Code** — bump the installed dependency (`pnpm`/the CLI does this).
2. **Data** — *this skill*: edit the harness dir (agents, plugins, secrets) to
   match the new version, then stamp `harness.json`.

You are operating **on a harness data dir** — the dir with `harness.json`, a
`package.json` depending on `@cognisphere-sh/cognisphere-harness`, and `agents/`.
In an app home (the `cognisphere init` scaffold) that's `harness/` under the
home root; the CLI accepts either dir as cwd. The home is a git repo, so every
change is a reviewable diff with trivial rollback. **Do not** touch `.secrets/` contents unless a breaking change
explicitly requires it, and never commit `.secrets/`.

## Procedure

### 1. Establish the version window

```bash
cognisphere upgrade            # prints data version, code version, and the
                              # CHANGELOG breaking-change sections in between
```

- If it says **"Up to date"** → stop; nothing to migrate.
- If **data version is ahead of code** → the code hasn't been bumped. Run phase 1
  first: `cognisphere upgrade --to <target>` (or `pnpm add @cognisphere-sh/cognisphere-harness@<target>`), then re-run `cognisphere upgrade`.
- Otherwise you get a **breaking-change window** `(data, code]` to apply.

If the user passed a target version, bump first with
`cognisphere upgrade --to <target>` before reading the window.

### 2. Read the breaking changes

Each section in the window is a `## <version>` block. The machine-readable part
is the `### Breaking changes` list; every entry has the form:

```
- <what changed>   [affects: <path glob>]
```

The `[affects: …]` glob scopes which forked artifacts the change touches —
e.g. `agents/*/agent.json`, `agents/*` (forked prompts/scripts), `plugins/*`,
`.secrets/`. Process versions **in order, oldest first**.

### 3. Plan the concrete edits

For each breaking-change entry, resolve the glob against the harness dir and
determine the exact edits. Common shapes:

- **`agent.json` field rename/move** → edit every matched `agent.json`,
  preserving user values.
- **Base prompt change** (`agents/*/system_prompts/0-base_prompt.md`) →
  **replace the fork's copy with the new seed** (re-baking the create-time
  template vars from the fork's current values). `0-*` prompts are
  harness-owned and stay in sync with the installed version; all agent- or
  app-specific instructions belong in `1-agent.md`. If a fork carries local
  edits in a `0-*` file, move them into `1-agent.md` as part of the upgrade
  instead of grafting them back.
- **Other seeded prompt/script change** → apply the documented edit on top of
  the user's forked copy under `agents/*/` (the user's edits are the baseline;
  graft the change, don't overwrite).
- **Plugin contract change** → update each forked plugin under `plugins/*` that
  is affected and flag incompatibilities.
- **Secrets/config reshape** → describe the required `.secrets/` edit for the
  operator to perform; prefer instructing over editing secret values yourself.

Keep edits **surgical** — only what each entry requires (CLAUDE.md §3).

### 4. Refresh the harness-owned scaffold files

Independent of the breaking-change entries, re-copy every **harness-owned**
scaffold file from the installed package, so the home tracks the shipped
versions (fixes that never got a breaking-change entry still land):

```bash
PKG=harness/node_modules/@cognisphere-sh/cognisphere-harness   # or node_modules/… when cwd is the harness dir
cp -R "$PKG/home-template/scripts/." scripts/
cp "$PKG/home-template/config.example" config.example
cp -R "$PKG/home-template/docs/base-harness/." docs/base-harness/
cp "$PKG/CHANGELOG.md" docs/base-harness/CHANGELOG.md
cp -R "$PKG/skills/." .claude/skills/
```

Local edits to these files show up as **reverted lines in the step-5 diff** —
call them out and re-apply the deliberate ones on top. **User-owned files are
never refreshed:** `app/`, `docs/harness/`, `docs/app/`, `CLAUDE.md`, `config`,
and everything under the harness data dir (that's what the breaking-change
entries scope).

### 5. Show the diff and get approval

```bash
git -C . add -A && git -C . --no-pager diff --staged
```

Summarize the plan and the diff. **Wait for explicit user approval.** Do not
proceed on your own.

### 6. Finalize

After the user approves the applied edits, stamp the data version so it matches
the code:

```bash
cognisphere upgrade --set-version <code-version>
```

Then suggest the operator review and commit the change, and restart the
server (`cognisphere dev`/`serve` locally, or `sudo ./scripts/server.sh restart`
on a deployed host) so the running runners pick up the migrated config.

## Guardrails

- Inside the harness data dir, never widen scope beyond the `[affects:]`
  globs; outside it, touch only the step-4 scaffold list.
- Never edit or print `.secrets/` values; only describe required operator edits.
- If a breaking change is ambiguous against this harness's actual files, stop and
  ask rather than guessing.
- If `cognisphere upgrade` reports no CHANGELOG entries in the window, just run
  `--set-version <code-version>` to reconcile the stamp.
