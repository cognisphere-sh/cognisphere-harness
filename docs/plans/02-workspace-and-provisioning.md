# Plan 1.2: agent directories and persistent filesystem

**Status:** planned. **Delivery:** M1 directory/resources/configuration, M2 SDK integration and writer ownership, M5 persistent Docker mounts, M11 image customization. [Delivery order](../roadmap.md#delivery-order). **Depends on:** no runtime migration for the M1 scaffold/resolver; execution uses the [SDK host](01-sdk-runtime.md). **Layers:** agents, core, plugins, API and CLI. [FAQ](#faq).

## Objective

Start with three clearly owned directories: **base**, **agent-managed**, and **sessions**. Base contains approved defaults, agent-managed contains writable overrides and work products, and Pi directly owns session JSONL on the persistent filesystem. There is no harness session archive, transcript storage adapter, memory provider or per-turn workspace snapshot.

M1 delivers the layout, resource resolver and validated main/sub-agent configuration before changing execution. It can scaffold a new agent, preview each role's effective prompts/skills/scripts/model, and produce a migration dry run. Move existing running agents only after M2 can execute against the new layout; preserve original files and customizations during migration.

## Data boundaries

```text
<harnessRoot>/
  control/                              trusted queue/run/task/operation metadata,
                                        plugin cursors/schedules, vault refs, staging
  runtime-installations/<agent>/<platform>/<recipe-hash>/
                                        approved Process dependencies
  runtime/<agent>/                      nonsecret run specs and temporary scratch
  agents/<agent>/
    agent.json                          trusted main/sub-agent configuration
    base/releases/<revision>/           read-only approved resource bundle
      manifest.json
      prompts/ skills/ scripts/ install/
      plugins/<plugin>/                 plugin prompts, skills, scripts, install steps
    agent-managed/                      shared writable cwd and persistent data
      resources.json                    ordered permitted resource additions
      prompts/ skills/ scripts/         new content and same-ID overrides
      install/ config/                  image-step drafts and nonsecret preferences
      files/ .deps/                     work products and project dependencies
      plugins/<plugin>/                 attachments, files, rebuildable cache
      state/profiles/<thread>/<session>/ separate HOME/browser/config state
    sessions/<thread>/<session>/        Pi-created and Pi-maintained JSONL
```

`agent-managed/` is the shared workspace. It can contain ordinary notes as files; no special memory directory, recall hook or memory service is prescribed. Profiles are separated by logical session, but live under persistent agent-managed state. Temporary scratch and harness-produced run specifications stay outside these three durable content roots; no secrets enter them.

| Resource | Process path | Docker path |
|---|---|---|
| Base resources | Selected `base/releases/<revision>` | `/assets`, read-only image content or a pinned read-only mount |
| Agent-managed cwd | `agent-managed/` | `/workspace`, persistent read-write mount |
| Pi session files | `sessions/<thread>/<session>/` | `/sessions/<thread>/<session>/`, persistent Pi-writable mount |
| Profiles | `agent-managed/state/profiles/...` | Scoped paths under `/workspace/state/profiles/...` |
| Run specification/scratch | `runtime/<agent>/...` | Read-only spec transfer or host channel; bounded temporary scratch |

Fix parent mounts at sandbox creation. Do not mount trusted control data, host HOME, another agent's roots or a Docker socket. Use explicit environment/resources and disable ambient credential discovery. Process is `[no sandbox]`: same-owner files are not enforceably immutable there. The Docker baseline also does not isolate hostile sessions from each other's readable files. Strict tools would require a separate boundary without session mounts.

[Plan 1.8](10-agent-simplification.md#resolution-and-override-rules) owns exact resource resolution: namespaced IDs, agent-managed-over-base precedence, whole-skill replacement, explicit prompt ordering, permitted additions and role selection. Both main and sub-agent manifests are configured in M1; execution arrives in M2/M3. Base files stay read-only, and later base-update permission publishes a new immutable release.

## Pi-owned sessions

Pi creates, appends, compacts, branches and resumes its JSONL directly in `sessions/`. The harness gives the SDK an explicit session directory, the selected existing session reference when resuming, and the shared cwd. Use Pi's supported session APIs, including cwd override where required for an older header; never rewrite transcript headers to move an agent.

The harness retains only routing/control metadata: agent/thread/role identity, Pi session ID/file reference reported by the SDK, active run, input-to-entry correlation and task/operation receipts. This is not another transcript store. Do not copy JSONL after every run, export/import it around a sandbox start, maintain archive/restore heads, or implement a second session serializer/repairer. Session files remain on the same backing filesystem when compute stops or is replaced.

Before launch, verify the configured persistent roots exist, belong to the expected agent/volume and have the required access. First-time directory provisioning is an explicit action; a missing mount or unexpectedly missing known session must not silently create empty replacement history. If the filesystem is unavailable/full/read-only or Pi reports an open/write error, stop the affected run and expose `recovery_required`; preserve existing bytes, revoke grants and prevent unsafe handoff. Do not replay a completed external action to compensate for a session-file error.

On restart, reconcile or externally stop old compute before reopening the same files. Pi handles its supported session recovery behavior; the harness surfaces errors and never truncates or repairs JSONL itself. A read-only UI/search consumer may skip an incomplete trailing record and retry later, but never writes the file. Infrastructure backup/restore is an operator concern, not a per-turn archive workflow or a promised filesystem rollback feature.

## Execution and the workspace gate

Keep one sandbox per agent and the existing `maxConcurrentSlots: 1`. One reservation covers preparation, execution and finalization; other sessions remain in the durable queue. Acquire the agent-wide writer lease before shared reads or SDK/extension startup. The gate also coordinates plugin file publication, dependency installs, operator edits and maintenance.

Pi settlement is necessary but does not prove detached tools stopped. Revoke grants during bounded shutdown, close the SDK child, establish that its descendants cannot write and commit trusted run/queue outcome metadata before releasing ownership. There is no session-copy, archive receipt or workspace-checkpoint step. If cleanup or the control-state commit is uncertain, retain recovery ownership until reconciled; expiry alone is never permission for another writer.

Two sessions sharing one directory could otherwise overwrite each other's read/modify/write operations. Serialize managed writers, reread current files on each turn, and use expected-content/hash checks for instrumented edits. Arbitrary bash or an external editor can still make a bad semantic edit; the gate does not merge changes or provide a rollback snapshot. Pause/drain before unmanaged host edits.

Plugin downloads may enter trusted staging while a run owns the workspace. Publication validates paths/symlinks, acquires the same gate, atomically places the file where possible, and records a durable publication receipt. An in-turn action must use a coordinated subordinate operation under the current fence or return a pending receipt; it cannot wait for an independent lease held by its own caller. See [ingress/operations](04-ingress-and-operations.md).

## Native provisioning and image builds

A versioned recipe pins assets, platform, SDK/Node/Python versions and dependencies. Build approved Process dependencies in a temporary installation path, smoke-test them, then publish a ready installation without mutating the previous one. Agent-managed project dependencies under `.deps/` use the writer gate.

M5 packages the approved base into a read-only image. M11 adds snapshotted agent-managed install steps in an isolated builder after base/plugin setup, with allowlisted dependency outputs and protected runtime/base hashes. Never execute editable installers as trusted host bootstrap. [Plan 1.8](10-agent-simplification.md#1-base-assets-workspace-and-images) owns that build/publication policy.

## Acceptance and migration

- M1: create/preview base, agent-managed and sessions roots; preserve customizations as overrides; validate main/sub-agent resources, descriptions and model inheritance. Read-only defaults and writable overrides resolve correctly without copying seeds over edits.
- M2: Pi writes and resumes the same JSONL files across child/harness restarts; original bytes are never transformed by a harness storage layer. Main/sub-agent histories stay separate while work files are shared. A runs while B/C queue; stale edits fail and all managed publishers use the gate.
- M5: container removal preserves both backing mounts; wrong/missing mounts and Pi file errors are visible failures. No empty-history fallback, overlapping old/new writer or control/credential mount is allowed.
- Before moving existing data: drain, back up through operator tooling, classify unchanged defaults versus custom edits, map existing session references and move files intact. Verify Pi can reopen them; stop the old runtime before the new one writes. A rollback preserves new queue/operation outcomes and never silently deletes newer files.

## FAQ

### Who owns session JSONL?

Pi alone handles creation, append, compaction and resume. The harness selects the session through Pi's API and stores the reference needed for routing. It does not archive, copy, repair or reconstruct transcripts.

### Is another database required to persist sessions?

No. The mounted `sessions/` filesystem is the session store. The harness's existing control database still owns queued inputs, runs, delegated tasks and external operation receipts; these are not transcript storage.

### Does persistent storage eliminate the need for a writer gate?

No. Persistence controls file lifetime; the gate controls overlapping access. It remains held through verified SDK/tool cleanup and trusted outcome recording, without a per-turn snapshot.

### What happens when a mount is missing or Pi cannot write?

Fail visibly, preserve the expected session reference/files, reconcile the old writer and enter recovery. Do not create an empty replacement history or implement a custom JSONL repair path.

### What replaces the memory implementation?

Nothing is required. The agent may keep ordinary files/notes in its writable directory. No MemoryProvider, extraction, automatic recall or memory lifecycle is part of this roadmap.
