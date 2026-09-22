# Plan 1.8: agent and automation simplification

**Status:** planned; no runtime behavior changes in this document. **Depends on:** [1.1 SDK/admission](01-sdk-runtime.md), [1.2 workspace/provisioning](02-workspace-and-provisioning.md), [1.4 ingress/broker](04-ingress-and-operations.md), and [1.7 protection/cutover](07-protection-and-cutover.md). Agree on these resource and automation interfaces while building those foundations; activate this task after their gates pass. **Layers:** all six. [Roadmap](../roadmap.md#1-sandbox-implementation).

## Objective and decisions

Make an agent a versioned base, a persistent workspace, and an explicit configuration of roles and capabilities. Move integration instructions into plugins; let small scripts decide routing and monitoring; retain trusted authority outside all agent-authored code. This is one roadmap task with six implementation parts below, not six new services to deploy.

| Concern | Decision |
|---|---|
| Base assets | Build the agent's base release into a pinned image; run it read-only. A versioned read-only mount is an alternative delivery mechanism for development/Process, using the same manifest. |
| Workspace | One persistent shared cwd with work files, plugin downloads, and agent-authored resource overrides. Histories/profiles stay separate per logical session. |
| Main and sub-agents | One agent identity, image and sandbox; explicit role-specific resources, separate histories, asynchronous delegation, one executing turn. |
| Credentials | Existing secret manager behind a typed broker; neither the guest nor editable automation receives upstream secrets. |
| Routing | A bounded script returns delivery decisions; trusted ingress validates and durably records them. |
| Monitoring | One script lifecycle with `daemon`, `cron`, or `at` triggers; action-only plugins need no monitor. Harness supervises isolated workers outside agent compute. |

## 1. Base assets, workspace, and images

Extend [plan 1.2's layout](02-workspace-and-provisioning.md#data-boundaries), keeping its existing `/assets` and `/workspace` paths. The agent's **base directory** is the selected `assets/releases/<revision>/`; it contains all agent-facing defaults, including plugin assets. Keep trusted server plugin implementations in the harness installation, outside agent images.

```text
agents/<agent>/
  agent.json                              trusted configuration; nonsecret references
  assets/releases/<revision>/             base source, immutable after publication
    manifest.json                         resource IDs, hashes, dependency recipe
    prompts/ skills/ scripts/ install/     agent defaults and base install entry point
    plugins/<plugin>/                     manifest, prompts, skills, scripts, install
  workspace/                              persistent shared cwd: /workspace
    resources.json                        ordered additions for permitted roles/namespaces
    prompts/<namespace>/                  new prompts and same-ID overrides
    skills/<namespace>/<name>/            complete skill bundles, including SKILL.md
    scripts/<namespace>/                  execution helpers, routes, cron, daemon drafts
    install/                              ordered post-base install steps
    config/                               nonsecret script configuration
    files/ memory/ .deps/                  work products, notes, project dependencies
    plugins/<plugin>/{attachments,files,cache}/
  sessions/ profiles/ runs/ scratch/       retain plan 1.2's scoped layout
control/
  automation/releases/<digest>/           immutable script/config/dependency snapshots
  plugins/<agent>/<plugin>/               durable cursors, schedules and private state
  ...                                    queues, policies, vault references, staging
```

All durable agent work and plugin downloads survive batches and sandbox replacement. Scratch is deliberately temporary. Private control state, schedules/cursors, and secrets must not move into the agent's writable workspace merely to put everything under one directory. Session recovery remains independent of workspace recovery.

**Use images and read-only enforcement together.** An image packages the correct Pi SDK, OS packages, CLIs, base prompts/skills/scripts and plugin resources; a read-only root prevents changes to those files at runtime. Do not copy assets out into a writable directory on startup. A read-only bind mount is useful for local iteration, but still needs a versioned source, pinned dependencies and controlled activation; host-side changes can otherwise change what the guest reads. Mounting over an image directory also hides its packaged contents, so select one source for `/assets` per launch. See [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/).

Build order is fixed: pinned runtime parent → base install → selected plugin install steps in manifest order → workspace `install/` steps in declared order → smoke checks → immutable image digest. The image includes the union of resources selected for the main agent and its sub-agents. Provision dependencies for that union once; choosing a role does not start another image or plugin listener.

Workspace installers run in a separate untrusted build stage. Export only validated dependency outputs into a distinct `/opt/agent-deps/<revision>/` prefix; do not let that stage replace `/assets`, the pinned SDK/supervisor, or trusted runtime libraries. Assemble the final image from the trusted base plus those outputs and verify protected file hashes. Reject symlink/path escapes and changes outside the allowed prefix. System-level changes outside it require a separately authorized base recipe update. Use explicit runtime entry paths and environment; dependency search paths must not shadow the supervisor. Do not install image dependencies into `/workspace/.deps`: the persistent workspace mount would hide them. That path remains available for separate project installs at runtime.

Snapshot the exact workspace installer/dependency inputs under the writer gate. Build in an isolated builder with no harness filesystem, Docker socket, vault identity or upstream credentials exposed to the build steps. The trusted controller manages the builder; untrusted install scripts do not get its credentials. Resolve private dependencies through a trusted fetch/cache service. Even temporary build-secret mounts are readable by the script consuming them; they do not hide secrets from untrusted installers. Never put secrets in `ARG`, `ENV`, layers or build context. [Docker build-secret documentation](https://docs.docker.com/build/building/secrets/)

An installer edit requests a new image; it does not run on every message or mutate the active runtime. Record base digest, asset/installer/lockfile hashes and platform in the recipe hash. Failed builds preserve the active image. Activate successful builds through the existing drain, confirmed stop, replacement flow; preserve the workspace and never overlap agent sandbox generations. Process mode uses approved native installations and remains `[no sandbox]`; untrusted installers must not become automatic host bootstrap commands.

Base updates default to denied. A trusted per-agent `baseAssets.publish` permission may allow that agent to submit and activate a validated new **agent-specific** release, within declared paths. Keep live assets read-only even for that agent. Publishing a release does not grant permission to change harness code, policy, credentials, or other agents' bases. The guest cannot grant itself this permission by editing a manifest.

### Resolution and override rules

1. Assign each resource a stable namespaced ID, such as prompt `agent/persona`, skill `browser/browse`, or script `browser/open`. Namespace is part of the name: two plugins' `search` skills must not collide accidentally. Reject ambiguous duplicate IDs in the base catalogue.
2. Select the role's plugins, prompts, skills and scripts from trusted `agent.json`. Resolve a selected ID from the workspace first, then the base. Same-ID prompts replace the complete fragment **at its existing ordered position**. Same-ID skills replace the complete skill directory so relative scripts/assets come from one coherent version. Script overrides execute only as guest code unless separately published for automation.
3. `workspace/resources.json` can register new skills/scripts and ordered prompt additions for the role's explicitly permitted `workspaceNamespaces`. Append new prompts after the configured prompt list in the declared order; same-ID overrides retain the original position. Reject duplicates, missing references and namespace violations. Unlisted new prompts do not silently change the system prompt. Deleting an override reveals its base version on the next resolution.
4. New workspace content may refine already-authorized capabilities; it cannot add a plugin, expand a broker scope, load privileged Pi extensions, or alter routing/secret policy. Every configurable base prompt and skill supports the above override rule; mandatory runtime identity/protocol metadata is supplied separately by the host. Security does not depend on an uneditable prompt.
5. Under the workspace gate, resolve and record one resource manifest per turn: role/config/base/image revision, ordered prompt IDs, source paths and content hashes. Pass the exact manifest to the SDK. Disable global/project discovery and prevent extension resource-discovery hooks from silently adding omitted resources. Detect duplicate Pi skill names before initialization rather than relying on loader order. Later additions/selection changes affect the next turn's catalogue; prompt edits do not rewrite an active conversation's loaded system prompt. This does not freeze lazy file reads: an agent may edit and reread a selected workspace skill/script during its turn. Record its actual revision when read/executed if exact replay provenance is required.

Workspace overrides persist across base upgrades; an upgrade reports shadowed/removed base IDs for review without overwriting custom files. This is a resource resolver, not filesystem overlay magic: the original base files remain readable in the shared image. Selection reduces context; it does not hide files from a role with arbitrary file/shell access.

## 2. Small core prompt and capability plugins

Keep only identity, current task/thread, workspace conventions, tool-use essentials and delegation protocol in the minimal runtime context. Move TTS/STT, web search, browsing, media processing and integration-specific behavior into their respective plugin bundles. Keep a normal agent's persona separate from platform/developer administration instructions.

A plugin manifest declares its description, named prompt fragments, skills, scripts, dependencies and available broker operation schemas. Selecting a plugin makes those resources eligible; the role's ordered prompt list determines which instructions are actually injected. Do not automatically append every installed plugin's prompt or recursively load every skill in the image. Trusted operation grants are the intersection of role selection and operator policy, not a consequence of text in a prompt.

Migrate current sorted-all-prompts assembly, whole-tree skill loading, unconditional core-plugin enablement and repeated seed copying. Preserve unchanged shipped files as base resources and genuine local edits as workspace overrides; ambiguous edits require a migration report, not silent replacement. Current behavior is documented in the [agents](../low-level/agents.md) and [plugins](../low-level/plugins.md) layer references until implementation lands.

## 3. Main-agent and sub-agent configuration

A sub-agent is a named execution role of the same agent, not another persistent agent identity or sandbox. Store its description and explicit resources alongside the main role in `agent.json`. Generate the main agent's catalogue from allowed main-agent descriptions and its own sub-agent descriptions; list each entry's kind/address. Sub-agents receive only their task, selected context, and parent return address. They do not receive the global catalogue, parent transcript, or full harness/admin prompts by default.

Illustrative **proposed** configuration; this is not today's `AgentJson` schema:

```json
{
  "id": "assistant",
  "description": "Personal assistant that coordinates research and communication.",
  "sandbox": { "maxSessionsPerSandbox": 4 },
  "maxConcurrentSlots": 1,
  "base": { "assetRevision": "r42", "image": "registry/assistant@sha256:<digest>" },
  "plugins": ["agent-messaging", "browser", "gws", "telegram", "scheduler"],
  "main": {
    "description": "Plans work and coordinates specialists.",
    "plugins": ["agent-messaging", "gws", "telegram", "scheduler"],
    "prompts": ["agent/persona", "agent-messaging/main", "gws/usage", "telegram/usage", "scheduler/usage"],
    "skills": ["agent/planning", "gws/mail"],
    "scripts": ["agent-messaging/send", "gws/cli", "telegram/cli", "scheduler/cli"],
    "workspaceNamespaces": ["agent"],
    "catalogue": { "mainAgents": ["research"], "subagents": ["browser"] }
  },
  "subagents": {
    "browser": {
      "description": "Browses websites and returns findings with source links.",
      "plugins": ["agent-messaging", "browser"],
      "prompts": ["browser/task", "browser/usage", "agent-messaging/child"],
      "skills": ["browser/browse"],
      "scripts": ["browser/cli", "agent-messaging/send"],
      "workspaceNamespaces": ["browser"],
      "messaging": { "sendTo": "parent" }
    }
  },
  "routing": { "script": "agent/route", "config": "config/routes.json" },
  "automation": {
    "telegram-ingress": { "plugin": "telegram", "trigger": "daemon", "script": "telegram/listen" },
    "gmail-watch": { "plugin": "gws", "trigger": "cron", "cron": "*/5 * * * *", "timezone": "UTC", "script": "agent/check-mail", "config": "config/mail-watch.json" }
  },
  "permissions": { "baseAssets": { "publish": false }, "automation": { "publish": ["agent/route", "agent/check-mail", "telegram/listen"] } }
}
```

The top-level plugin list is the installed union, not a grant to every role. `agent.json` is operator-controlled; the harness compiles its publication permissions and operation/account/destination scopes into trusted policy. Agent-authored config files hold routing preferences and filters within that envelope. No secret values belong in either. A privileged configuration change is distinct from editing a workspace override.

Use the existing agent messaging protocol with `roleId`, `taskId`, `parentSessionId`, correlation/reply IDs and durable receipts added to the envelope. The harness derives the sender; an arbitrary message field cannot set it. The child keeps the parent's `agentId` while receiving its own logical session/history/profile and a grant scoped to that role/task. Child messaging permits only its bound parent; no sibling, external/main-agent catalogue, recursive delegation or user-channel send by default. A browser plugin's typed browsing operations are distinct from messaging permissions.

**Baseline delegation is asynchronous:** the parent submits the task, receives an acceptance receipt, and ends/yields its turn. Settle and close the child, prove descendant cleanup, revoke its grants before slow persistence, then archive/checkpoint before releasing its admission reservation and writer lease. The parent is durably `awaiting_child`, with no live SDK child. The sub-agent then obtains ordinary admission and the same agent's writer gate. Its result is a durable message to the parent, which is re-admitted using its existing history and rereads changed workspace files. The parent must not synchronously await a queued child while holding the gate or a required capacity slot. This works even with `maxSessionsPerSandbox: 1`; full capacity queues children fairly without allocating another sandbox.

Record task state (`queued`, `running`, `succeeded`, `failed`, `cancelled`), result receipt, retry budget and parent continuation durably. A repeated task/result ID returns its receipt; restart never repeats a confirmed external operation solely to reconstruct a result. Cancellation propagates through the task relationship, and terminal failure resumes the parent with a failure result. No in-memory promise is the only record of delegated work.

Narrow context and broker-issued role scopes support cooperative specialization. Shared OS identity/files mean these roles are **not hostile-agent isolation**; hiding a prompt/plugin from context does not make it inaccessible via bash. A hard child-to-parent-only security guarantee against arbitrary guest code would require a separately enforced tool/process boundary. Do not claim that the shared-image baseline provides that guarantee.

## 4. Secret vault and operation broker

Use two separate responsibilities: a `SecretProvider` stores/retrieves encrypted credentials for trusted adapters; the operation broker authorizes **actions** requested by agents and automation. Do not build a new general-purpose vault as part of the harness. Use the deployment's managed secret service, or OpenBao for a self-hosted vault; keep a provider interface so the choice does not enter guest code. OpenBao encrypts storage and documents the trusted-host/key-management limits of that protection. [OpenBao security model](https://openbao.org/docs/internals/security/)

For a local encrypted-store adapter, use a maintained authenticated-encryption implementation with envelope encryption: per-record data keys, ciphertext and wrapped data keys on disk; a separate OS keystore or KMS protects the wrapping key. Never save the usable master key beside the ciphertext or in the same `.env`/backup. Prefer a managed vault to owning key rotation/recovery code; verify unattended unlock/recovery for the deployment. Envelope encryption keeps the encryption key's protection separate from the data store. [Vault envelope encryption](https://developer.hashicorp.com/vault/docs/secrets/transit/envelope-encryption)

```text
Guest CLI / isolated automation
  -> typed action + limited expiring grant
  -> broker: authorize principal, operation, account, destination, limits
  -> trusted plugin adapter -> SecretProvider -> upstream service
  <- bounded result / structured file reference / durable receipt
```

Only the trusted adapter can resolve a secret reference. There is no guest `getSecret`, decrypt endpoint, arbitrary authenticated HTTP proxy, or environment export. Credentials appear briefly in trusted adapter memory when required; encryption cannot hide them from that adapter or a compromised trusted host. Guests can read their broker grants, which authorize limited operations; these are intentionally distinct from upstream credentials.

Run-bound grants use plan 1.4's session/run/fence/generation checks. Background automation needs a separate `AutomationPrincipal` bound to owner agent, plugin/account, script digest, activation generation, job occurrence, policy revision and expiry: it must work when no agent session or sandbox exists. Grant renewal requires a live trusted job/daemon lease and current policy; broker authorization also checks revocation independently of pinned code. The server chooses permitted secret references, endpoints and operations. Scripts cannot select arbitrary vault paths, override authentication headers, follow authenticated redirects to attacker hosts, or obtain token-bearing error/debug responses. Bound and sanitize request/results/logs; no credential values in events, sessions, image layers or archives. Reuse operation IDs and uncertain-outcome recovery from plan 1.4.

Prefer workload identity for the broker's vault access, scoped policies, rotation/revocation and encrypted backups with tested restore. Guest and automation workers have no vault route/identity; strict profiles enforce network restrictions externally. CLIs that insist on raw credentials must execute behind a typed trusted adapter; a guest wrapper preserves their useful command syntax. Hiding a value from the model while placing it in the guest's environment is insufficient.

Migrate existing plaintext credentials by importing through a trusted channel, switching references, verifying integrations and removing plaintext copies from active configuration. Inventory historical files/backups/logs and rotate exposed values where necessary; deletion of today's file is not evidence old copies disappeared. Vault outages fail closed without falling back to plaintext or ambient host credentials. Future payments remain typed, policy-bound operations in a trusted payment executor; neither raw card details nor decryption keys enter the general agent browser.

## 5. Script routing

Replace static plugin channel/thread mapping and `threadIdStrategy` as the authoritative router with one versioned routing script entry point. Channel, account and provider thread IDs remain source data that the script may use. Optional JSON/YAML configuration belongs to the script; the harness need not understand every application's routing rules.

The route function takes a normalized source event, immutable nonsecret config and a scoped catalogue snapshot; it returns `drop(reason)` or a bounded array of `{ agentId, threadId, roleId?, text, attachmentIds, deliveryOptions }`. Ordinary ingress targets a main role. Reject sub-agent destinations unless trusted control state already binds that delivery to an authorized parent/task; a script cannot invent a delegation or orphan child by supplying `roleId`. It cannot replace the trusted source identity, acquire arbitrary permissions, or send external side effects. Keep routing bounded and deterministic for a given event/config revision; external lookups belong in producer scripts, not repeated route evaluation.

Persist source input and its selected router/config revision first. Run the router under time/memory/output limits, validate every destination/thread/attachment/option against trusted policy, then atomically persist the decision and all delivery intents in the control-side outbox. Materialize queue rows with stable keys derived from the source event and delivery identity; replay delivery intents until each destination records acceptance. Separate agent databases need no cross-database transaction. Pin retries to the recorded source/router/config revision; a later routing edit affects newly accepted inputs, not previously accepted sources or deliveries. An explicit reroute/replay is a separate audited action. Failure quarantines/retries the durable source; it must not silently drop it or deliver to a default agent.

The default shipped router can address the plugin's owning agent using source conversation IDs. Custom scripts may route to any authorized main agent or conversation. Direct scheduled task output may already name an exact agent/thread and use a `direct` delivery mode: validate it through the same ingress policy without applying the router a second time. External sources cannot choose `direct` merely by putting that field in their payload.

Removing per-plugin routing settings does **not** remove plugin configuration: account references, enabled producer, script/config revision and trusted destination policy still exist. Reply destinations derive from authenticated ingress/operation state; a changed routing JSON file cannot authorize sending messages to arbitrary accounts.

## 6. Scheduler, daemons, and editable automation

Use one `ScriptHost` contract for three entry points: `route(event)`, `run(occurrence)` and `start(context)`/bounded stop for a daemon. Scripts use a small versioned client for `emit`, scoped plugin operations, private state/checkpoints and file staging. Both cron and daemon producers emit the same durable event envelope; their trigger/lifetime differs.

| Integration | Producer | Behavior |
|---|---|---|
| Telegram | Daemon calling a trusted Telegram transport adapter | Continuous reception/long polling. Persist each update before advancing its cursor/acknowledgment. |
| Gmail/GWS | Agent-authored cron script calling brokered GWS operations | Poll/filter according to the agent's preferences; emit only matching mail to an explicit agent/thread. No built-in GWS notification monitor. |
| Reminder or periodic workflow | `at` or `cron` script | Compute content, perform permitted actions, emit zero or more events; no LLM invocation is required for an empty result. |
| Browser, TTS, other action-only capability | No producer | Supply actions/resources without a daemon or cron job. |

Do not label plugins intrinsically “active” or “passive.” A plugin declares actions and optional producer templates; configuration chooses daemon, cron, at, or none. A future GWS push integration could use a daemon without changing the notification contract. Trusted adapters own authentication/protocol plumbing; scripts own monitoring/filtering/routing behavior. Delete the old GWS monitor only after schedule/cursor migration is verified, so two pollers do not generate duplicate notifications.

Extend scheduler records with trigger (`at` or cron plus timezone), logical `scriptId` and config selection, arguments, owner, enabled state, concurrency limit, timeout, retry/backoff and misfire policy. On first claim, resolve the current active release and pin its immutable script/config revision on the occurrence; already-started work does not switch code mid-retry. Recheck trusted authorization at execution, so a pinned release cannot outlive revoked permission. Default to one active occurrence per schedule; make skip/coalesce/catch-up explicit and bounded. The occurrence key `(owner, scheduleId, scheduledAt)` is stable across retries and code updates. Mark a one-shot complete only after a durable execution result and any emitted event receipts, including successful zero-event runs.

An `emit` receipt means the harness durably accepted the event, not that an agent ran or a user received a reply. Stable source event/delivery IDs suppress duplicates. Separate upstream source acceptance from worker processing: an adapter may acknowledge a provider update after its raw input is durable; a worker advances its processing cursor only after committed emissions or a durable intentional skip. Gmail polling checkpoints follow the same emission rule. Crashes between acceptance and checkpoint safely replay the same IDs. Reading mail must not mark it read as an accidental acknowledgment. Attachment publication uses plan 1.4's staging and the shared workspace gate. Script side effects use the operation ledger; retries cannot manufacture exactly-once semantics from a provider that lacks dedupe/reconciliation support.

### Where scripts execute

The **harness owns scheduling and supervision**, so notifications continue while the sole agent sandbox is stopped. Run editable scripts in isolated, resource-limited workers on the harness side, outside its privileged Node process. These are integration workers with no Pi, agent workspace mount or agent session capacity; they do not create another agent sandbox or runtime generation. A restricted worker service can be shared infrastructure, but each job's filesystem, process access, identity and network authority must be isolated from unrelated jobs and the harness.

Mount only its published code/config read-only; provide bounded scratch and broker-mediated state/staging. Deny access to host HOME, process memory, control DB, sockets, vault and raw network credentials. A worker never writes `/workspace` directly; publication is a broker operation under the agent's gate. A same-user child process, `worker_threads`, or `node:vm` is not adequate isolation. Node explicitly states that `node:vm` is not a security mechanism. [Node VM documentation](https://nodejs.org/api/vm.html)

Operator-installed trusted adapter code may run in the harness. Agent-editable code must not be dynamically imported into that process. If a deployment cannot enforce worker isolation, disable editable host automation in that profile rather than promise that encryption hides secrets from arbitrary privileged code.

### Worker communication and credentials

Use one small authenticated HTTP/JSON client for notifications, plugin operations and state. On the same host, prefer HTTP over a Unix-domain socket exposed specifically to the worker. Across hosts, or container boundaries where socket sharing is unsuitable, use a private HTTPS endpoint with workload authentication (mTLS where supported). This is a webhook-style POST for notifications, but requires no public webhook URL per script. Socket reachability or a loopback address alone is not authorization. The listener exposes worker methods only, never the operator/admin API.

The supervisor supplies the worker's short-lived `AutomationPrincipal` grant through a protected launch channel, such as an inherited pipe or a worker-specific runtime channel. The worker can read this grant: its purpose is to authorize a bounded set of operations, not hide authority from the code using it. Do not use a global harness bearer token, command-line token, shared workspace file, or upstream credential for bootstrap. Bind renewal to the trusted worker lease and current policy. Agent-sandbox CLI wrappers use equivalent broker calls authenticated with their run grants instead.

Proposed internal surfaces, not currently implemented routes:

| Request | Result and enforcement |
|---|---|
| `POST /automation/v1/events` | One bounded output batch with stable input/occurrence and emission IDs, event bodies and requested destinations. Validate all outputs and atomically record the complete batch/outbox, including intentional zero-output completion; return a durable receipt. |
| `POST /automation/v1/plugins/:plugin/operations` | Typed action such as `telegram.sendMessage`, `telegram.updates.read` or `gws.gmail.messages.list`; authorize account/action/arguments and return data or an operation receipt. |
| Scoped state/checkpoint methods | Read/update only that script's state with revision/generation checks. Source cursors and ingress ownership cannot be overwritten arbitrarily. |

Resolve sender, account scope, script revision and activation generation from trusted state. The worker may request a destination agent/thread but cannot declare its own authenticated identity. Preserve `isSilent`/`doNotSteer` only within permitted delivery policy. A receipt means persisted ingress/outbox, not successful agent execution. Retry a lost response with the same batch identity and payload; return the original receipt for an identical retry and reject changed payloads. For consumer work, bind the batch to its assigned source delivery and pinned script/config revision. Commit the entire output manifest before advancing the consumer checkpoint, so partial fan-out cannot disappear on restart. Queue insertion at each target remains asynchronous and idempotent. No worker writes directly to the queue database. If the harness is unavailable, use bounded retry/backoff without advancing checkpoints; stop further reads when durable backlog capacity is exhausted. Worker scratch must not be the only copy of accepted input.

```text
Editable daemon / cron script / agent CLI wrapper
  -- limited grant + typed request --> Harness ingress / operation broker
                                      |-- durable notification --> agent queue
                                      |-- authorized operation --> trusted adapter
                                                                    |-- vault
                                                                    |-- Telegram / Google
  <-- durable receipt or bounded operation result -------------------+
```

**Telegram:** the trusted adapter reads the bot token from the vault and owns a single upstream receiver per bot/account. In the initial long-polling design, it persists raw updates in a durable inbox before advancing Telegram's offset. The editable daemon consumes that inbox through `telegram.updates.read`, filters/transforms updates and emits a batch; it never receives the token or controls the upstream offset. Its separate consumer checkpoint advances after the batch receipt. Replies use `telegram.sendMessage` through the same broker. Telegram also supports an external webhook, as an alternative to polling: terminate it at trusted ingress, authenticate it and persist before acknowledging. That provider webhook is a different connection from worker-to-harness HTTP. [Telegram update transport](https://core.telegram.org/bots/api#getting-updates)

Telegram download operations return staged file IDs or bounded bytes, never credential-bearing file URLs. Redact upstream URLs/errors before returning results to any worker or agent.

**GWS:** the scheduled script calls typed operations such as `gws.gmail.messages.list/get`, evaluates its own filters and emits notifications. The trusted adapter resolves the authorized account and refreshes OAuth credentials from the vault. It can call Google APIs directly or execute the pinned `gws` CLI in a trusted connector process. GWS supports an access-token environment variable and credential-file authentication; if using its CLI, supply credentials only to that trusted process, never the editable script or agent guest. [GWS authentication](https://github.com/googleworkspace/cli#authentication)

Prefer a short-lived access token for trusted GWS CLI execution; if a credential file is necessary, use private ephemeral storage with restricted ownership and cleanup, outside guest/worker mounts and logs. Construct allowlisted arguments/environment, use no shell interpolation and no untrusted working directory/module paths. Do not expose arbitrary CLI execution or credential-export commands as broker operations. A guest `gws` compatibility wrapper may translate supported commands into broker requests; an unmodified authenticated CLI running inside the guest cannot keep its own credentials unreadable from arbitrary guest code.

Trusted adapters may run inside the harness or in separately protected connector processes. They are installed/reviewed platform code with vault access. Editable workers are policy logic without vault access. Putting the token in an editable daemon's environment or a mounted secret file would let that daemon read and exfiltrate it, even if the backing store is encrypted.

### How agent edits take effect

1. The agent edits workspace scripts/config under its normal workspace lease. It calls a proposed `automation.publish(scriptId, expectedActiveRevision, candidateDigest)` operation. File changes alone never reload privileged code.
2. The broker checks trusted per-agent publication permission. Snapshot a dependency-complete bundle and nonsecret config at a coordinated tool boundary using the current fence, or return a pending publication receipt. Recompute its digest from the captured bytes and compare with `candidateDigest`, including when capture was deferred; stale/mismatched candidates fail. Validate and activate those exact bytes. Do not wait on an independent gate held by the requesting turn. Reject traversal/symlinks, unexpected files, stale revisions and attempts to expand scopes, interpreter, destinations or host paths.
3. Validate schema/syntax and sample fixtures in an isolated worker with mock operations. Copy accepted bytes to an immutable control-side release with provenance and hashes. Pin local imports/dependencies/config; activation must not later read mutable workspace paths. Syntax validation is useful but is not the security boundary.
4. Authorized changes within the existing policy can activate automatically; no repeated human approval is required. A base update, expanded capability/destination policy or ungranted publication requires a separate trusted authorization. The agent cannot self-authorize by modifying `resources.json` or the script's configuration.
5. Atomically compare and swap the active revision. New route invocations/cron claims use it; running jobs retain their pinned version. A daemon upgrade stops new work, drains accepted emissions/checkpoints, revokes the old activation, confirms worker exit and starts the new revision. No overlapping poller generations; stop uncertainty blocks replacement. Keep trusted ingress buffering webhook arrivals, or rely on provider replay for polling gaps.
6. Persist activation status, last error, heartbeat and rollback revision. On startup reconcile durable active revisions and occurrence/daemon leases before launching workers. Reject stale worker emissions/state updates. Retry/backoff and a restart-rate limit prevent crash loops; rollback selects a prior immutable release, preserving durable receipts/cursors. Version private state so an incompatible new script cannot corrupt the previous revision's recovery path.

Routing config changes use the same snapshot/activation path as code changes. Per-script private state is durable behind scoped APIs; only validated, nonsecret preference files are writable in the workspace. API/CLI/web should expose candidate versus active revision, publish/validation/reload outcome, schedule status, and failed/quarantined events.

## Implementation sequence and acceptance

Deliver incrementally inside this single roadmap task:

1. Resource catalogue/resolver, base image recipe, workspace additions/overrides and safe migration from copied seeds.
2. Small core prompt and capability plugin bundles; explicit ordered role config and SDK loading.
3. Durable asynchronous parent/child messaging, catalogue generation and single-writer scheduling.
4. Secret-provider implementation/migration, typed adapters and separately scoped automation grants.
5. Isolated script execution/publication, script routing, scheduler scripts and daemon lifecycle; migrate Telegram/GWS and remove redundant monitors/static routing.
6. Cross-layer API/CLI/web visibility, migration/rollback evidence, then update current layer and shipped app-home documentation.

| Acceptance scenario | Required result |
|---|---|
| Same-ID prompt/skill plus a new workspace resource | Override wins once; prompt order is deterministic; whole skill bundle is coherent; additions follow namespace/config policy; base upgrade preserves overrides. |
| Image install and forbidden base edit | Base → plugins → workspace install order is verified; protected assets/runtime hashes survive untrusted installer attempts; dependency outputs remain visible outside the workspace mount; no host code/secret access; failed build preserves old image and work files. |
| Main versus browser sub-agent | Same agent/sandbox/cwd, separate histories and exact selected resources; no omitted-plugin rediscovery; child grant refuses non-parent messaging. Disclose shared-identity limits. |
| Delegation at capacity 1, parent crash, duplicate result | Parent releases execution/capacity before child admission; no deadlock/second sandbox; result resumes the correct parent once through durable correlation. |
| Secret read, token echo, forged account, vault outage | No plaintext storage in agent paths, no upstream credential retrieval; broker validates accounts/egress/results and fails closed; scoped operation receipts survive retries. |
| Routing fan-out, error, changed script and replay | Authorized durable deliveries only; no partial fan-out loss, duplicate queue rows, implicit reroute or default silent drop. |
| Gmail cron and Telegram daemon with stopped agent compute | Monitoring continues; durable emit precedes checkpoint; downloads stage without racing workspace writes; GWS has no duplicate built-in monitor. |
| Cron timeout/restart, zero-event result, repeated side effect | Stable occurrence and operation IDs, bounded retry/misfire behavior, recorded completion or uncertainty without blind duplicate sends. |
| Edit/reload while an old daemon or cron run exists | Exact immutable code/config snapshot, no privileged import, no overlapping daemon generations, pinned in-flight jobs, failed activation leaves a recoverable revision. |
| Attempted worker host/peer/workspace access | Enforced isolation denies access; publication alone does not widen policy; unsupported Process profiles make no hidden-secret claim. |

Keep detailed runtime/storage algorithms in plans 1.1–1.7. This plan owns resource selection/overrides, specialist roles, vault-provider choices and editable automation; [plan 3](09-agent-improvement.md) remains the later evidence-driven review workflow, not a prerequisite for ordinary workspace customization.
