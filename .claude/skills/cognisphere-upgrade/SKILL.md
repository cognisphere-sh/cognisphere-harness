---
name: cognisphere-upgrade
description: Migrate a CogniSphere harness data dir to a newer harness version. Use when asked to "upgrade the harness", "run cognisphere upgrade", "migrate my agents to the new version", or after bumping the @cognisphere/cognisphere-harness dependency.
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

You are operating **inside a harness data dir** (cwd has `harness.json`, a
`package.json` depending on `@cognisphere/cognisphere-harness`, and `agents/`).
The harness dir is a git repo, so every change is a reviewable diff with trivial
rollback. **Do not** touch `.secrets/` contents unless a breaking change
explicitly requires it, and never commit `.secrets/`.

## Procedure

### 1. Establish the version window

```bash
cognisphere upgrade            # prints data version, code version, and the
                              # CHANGELOG breaking-change sections in between
```

- If it says **"Up to date"** → stop; nothing to migrate.
- If **data version is ahead of code** → the code hasn't been bumped. Run phase 1
  first: `cognisphere upgrade --to <target>` (or `pnpm add @cognisphere/cognisphere-harness@<target>`), then re-run `cognisphere upgrade`.
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
- **Base-template prompt/script change** → apply the documented edit on top of
  the user's forked copy under `agents/*/` (the user's edits are the baseline;
  graft the change, don't overwrite).
- **Plugin contract change** → update each forked plugin under `plugins/*` that
  is affected; check any `compatibleHarness` range and flag incompatibilities.
- **Secrets/config reshape** → describe the required `.secrets/` edit for the
  operator to perform; prefer instructing over editing secret values yourself.

Keep edits **surgical** — only what each entry requires (CLAUDE.md §3).

### 4. Show the diff and get approval

```bash
git -C . add -A && git -C . --no-pager diff --staged
```

Summarize the plan and the diff. **Wait for explicit user approval.** Do not
proceed on your own.

### 5. Finalize

After the user approves the applied edits, stamp the data version so it matches
the code:

```bash
cognisphere upgrade --set-version <code-version>
```

Then suggest the operator review and commit the harness dir, and restart the
server (`cognisphere dev`/`serve`, or `cognisphere up` on a deployed host) so the
running runners pick up the migrated config.

## Guardrails

- Never widen scope beyond the `[affects:]` globs.
- Never edit or print `.secrets/` values; only describe required operator edits.
- If a breaking change is ambiguous against this harness's actual files, stop and
  ask rather than guessing.
- If `cognisphere upgrade` reports no CHANGELOG entries in the window, just run
  `--set-version <code-version>` to reconcile the stamp.
