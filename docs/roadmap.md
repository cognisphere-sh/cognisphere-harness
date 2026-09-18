# Implementation roadmap

This roadmap links individual designs and tracks delivery, starting with sandbox implementation. All milestones below remain open; reference contracts are design artifacts, not completed integrations.

## 1. Sandbox implementation

Design: [sandbox runtime](design/sandbox.md).

### 1.1 Shared execution contract

- [ ] Extract compute management from `AgentRunner` into a runtime provider registry.
- [ ] Implement the shared file-backed Pi SDK host and `AgentHostClient`.
- [ ] Support working-directory overrides, ready/state exchange, and `agent_settled` handling.
- [ ] Keep queueing, delivery tracking, steering, cancellation, and retries shared across providers.

Complete when existing conversation behavior passes integration fixtures through the Process adapter, including compaction/retry before settlement. Retain the old launch path only for cutover, then remove it.

### 1.2 Persistent layout and native provisioning

- [ ] Separate trusted control data, immutable asset releases, sessions, workspace, and run scratch.
- [ ] Implement local volume preparation, workspace-file memory, and plugin data directories.
- [ ] Provision versioned native dependencies from approved recipes and verify readiness.
- [ ] Acquire session/workspace writer leases and record recoverable run identities.

Complete when repeated runs reuse dependencies and preserve workspace data, conflicting writers are refused, and Process profiles accurately report which protections they can enforce.

### 1.3 Session archives and recovery

- [ ] Implement session `beforeBatch` / `afterBatch` hooks and the local archive first.
- [ ] Add cloud and database archive adapters behind the same contract.
- [ ] Preserve active-session mappings, all relevant JSONLs, checksums, revisions, and restore eligibility.
- [ ] Implement `persistence_pending`, orphan recovery, and storage-only retries.

Complete when restore/resume works for each backend, partial sessions remain inspectable, and failed persistence neither loses live files nor reruns completed model work. Database search is a later milestone, separate from this optional archive backend.

### 1.4 Trusted ingress and plugin operations

- [ ] Persist incoming work independently of compute lifecycle.
- [ ] Add scoped run capabilities and a typed credential/operation broker.
- [ ] Migrate messaging, Telegram, GWS, scheduler, and artifact actions to the broker.
- [ ] Publish attachments through durable staging and the workspace checkpoint gate.
- [ ] Persist delivery receipts and deduplicate outgoing operation IDs.

Complete when plugins receive work while compute is idle, callbacks cannot spoof identity or lifecycle events, stale grants fail, and uncertain remote actions require reconciliation.

### 1.5 Docker runtime

- [ ] Build approved dependency images, smoke-test them, and pin digests.
- [ ] Implement create/attach/start/inspect/stop/remove with durable container identity.
- [ ] Enforce asset mounts, scoped writable paths, non-root execution, resource limits, and credential/network boundaries.
- [ ] Reconcile orphan containers and retry cleanup independently of model execution.

Complete when the same execution/recovery suite passes for Process and Docker, assets are read-only in Docker, and workspace/session data survives container removal. Validate mounts on Linux and Docker Desktop.

### 1.6 Live interface and delivery

- [ ] Add authenticated event streaming with audience filtering and reconnect cursors.
- [ ] Reconcile transient text with persisted messages and archived sessions.
- [ ] Show runtime/storage selection, idle versus running state, and pending persistence.
- [ ] Deliver explicit plugin/product replies independently of archive completion.

Complete when progress appears during execution, reconnect avoids duplicate final messages, and durable completion is not reported before persistence succeeds.

### 1.7 Protection profile and cutover

- [ ] For strict workspace-only tool access, separate tool execution from the Pi session writer and test all tool paths.
- [ ] Migrate one agent with a consistent backup, layout manifest, and rollback procedure.
- [ ] Exercise crash, cancellation, restart, storage failure, publication races, and forged/expired credentials.
- [ ] Update current-system, API, deployment, and shipped user docs as code lands.

Complete when no notifications, sessions, or plugin files are lost during cutover. A profile claiming strict workspace-only access cannot ship without its separate tool boundary. The baseline Docker profile must disclose the live-session write exception; Process remains visibly trusted where OS isolation is absent.

## 2. Session search and memory

Design: [sessions and memory](design/sessions-and-memory.md). Depends on stable session archives and scoped access from workstream 1.

- [ ] Backfill raw JSONL revisions into database storage and build a derived full-text index.
- [ ] Expose agent/thread-scoped search with source-entry links and pagination.
- [ ] Add bounded recall through the memory interface while retaining editable workspace notes.
- [ ] Apply deletion/retention to archives and derived indexes; verify rebuildability and access isolation.

Complete when session history is searchable across runs with traceable results, archived bytes still restore through Pi, and retrieval cannot cross unauthorized agent scopes.

## 3. Agent improvement

Design: [agent improvement](design/agent-improvement.md). Depends on searchable history and sandbox asset/workspace boundaries.

- [ ] Produce scheduled reports of recurring failures, repeated workflows, and skill usage.
- [ ] Propose source-linked changes as reviewable workspace drafts.
- [ ] Validate approved changes and publish asset releases through the trusted workflow.
- [ ] Record application/rollback outcomes and prevent changes while a conflicting workspace writer is active.

Complete when the first workflow produces useful review-only reports without changing active assets, and approved changes can later be applied and rolled back with evidence.
