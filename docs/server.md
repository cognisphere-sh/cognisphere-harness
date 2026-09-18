# Server reference

Use [system design](system-design.md) for the component map and diagrams. This reference covers current configuration, lifecycle hooks, and operating behavior. Planned runtime changes are in the [sandbox design](design/sandbox.md).

## 1. Entrypoint and configuration

`packages/harness/src/core/main.ts` constructs `PluginRegistry`, `AgentManager`, and `AuthStore`, starts agents, mounts Hono/API and raw webhook handlers, and registers shutdown cleanup.

| Setting | Default | Purpose |
|---|---|---|
| `COGNISPHERE_ROOT_DIR` | `~/.cognisphere` | Parent of harness instance directories. |
| `COGNISPHERE_ID` | `default` | Instance directory name. |
| `PORT` | `3142` | HTTP port. |
| `BIND_HOST` | `127.0.0.1` | Listener address. |
| `SERVER_BASE_URL` | `http://<bindHost>:<port>` | Base URL supplied to plugin/agent callbacks. |
| `COGNISPHERE_HEADLESS` | false | Disable the bundled console. |
| `LOG_LEVEL` | `info` | Pino logging level. |
| `harness.json.timezone` | `UTC` | Scheduling and timestamp timezone. |
| `harness.json.version` | empty if absent | Deployment data/migration version. |

`config.ts` attempts to load `.env` from the working directory. The CLI derives root/instance settings from the selected app home. `COGNISPHERE_WEBHOOK_SECRET` is generated per boot unless supplied and authenticates in-harness plugin callers.

## 2. Agent configuration

`agent.json` describes identity, model, routing, and runtime limits:

| Field | Behavior |
|---|---|
| `name`, `description` | Display identity and roster description. |
| `model.provider`, `model.id` | Default provider/model; catalog models must be enabled in Models settings. |
| `model.thinkingLevel` | Defaults to `medium` when spawning if unset. |
| `threadIdStrategy.type` | `single`, `plugin`, or `plugin_channel`. |
| `maxConcurrentSlots` | Defaults to 1, clamped to at least 1. |
| `maxAttempts` | Defaults to 3 failed attempts before terminal failure. |
| `secretsSchema` | Declares agent-level secret fields and required keys. |
| `configSchema`, `config` | Validated non-secret environment values; config keys require a schema. |
| `devAgent` | Marks the deployment developer agent created by the CLI. |

The seven tools are fixed. Agent configuration has targeted validation rather than a complete schema gate for every field. Unknown model providers can fall through to Pi's ambient configuration.

`SecretsStore` reads `.secrets/secrets.json` as `agentId -> bucket -> key/value`; bucket `agent` is reserved for agent-level secrets. Plugin contexts receive declared keys from their own bucket. The child receives all nonempty keys across its agent's buckets. Duplicate bucket keys and collisions with resolved provider/config keys fail startup.

`ModelsStore` reads `.secrets/models.json` on demand. `models-catalog.ts` maps credentials to provider environment names. OAuth provider tokens live in Pi's runtime `auth.json`; Google Workspace credentials instead live under the harness's `.secrets/gws/`. `pi-models-sync.ts` mirrors model overrides into Pi's runtime `models.json`.

## 3. Persistent state

The [system-design storage section](system-design.md#state-and-recovery) shows the directory layout. The authoritative current stores are:

| Store | Writer / readers |
|---|---|
| `sessions/.events.db`, `events` | Runner writes lifecycle state; API reads/edits non-active rows. |
| `sessions/.events.db`, `threads` | Runner creates canonical session bindings; API sets model overrides. |
| `sessions/<thread>/<session>.jsonl` | Pi appends conversation entries; session API reads them. |
| Plugin `state/` and `inbox/` | Plugin-owned cursors, schedules, output, and attachments. |
| `.secrets/` | Settings/auth APIs and operator-managed credentials. |

Database startup uses `CREATE TABLE IF NOT EXISTS` and additive column checks. It does not drop the event history. The legacy `.queue.db` file is left untouched. For older thread directories without a binding, startup backfills from the most recently modified JSONL.

Database handles stay open across agent stop/start and close on server shutdown. Back up SQLite consistently, including any live WAL state. Include Pi's separate runtime credentials when needed for restoration. There is no automatic session/event retention policy.

## 4. Plugin lifecycle

`PluginRegistry.scan()` scans packaged definitions, then user definitions, dynamically importing `<pluginId>/index.ts`. `get()` returns the constructor, manifest, source directory, and scope. Instances are created per agent by the manager.

`PluginInstanceContext` contains agent identity/directories, plugin state/inbox directories, validated config, declared secrets, timezone, logger, optional HTTP base URL, `notify(name, payload)`, and `resetThread(channel, override?)`.

On plugin start, the manager copies `seed/` into the agent tree, makes scripts executable, validates/defaults config with Ajv, checks required secrets, creates state/inbox directories, then calls `start(ctx)`. These seed files are overwritten on each start. Core IDs `admin`, `scheduler`, and `agent-messaging` always participate; other IDs come from the agent's plugin directories.

`notify()` adds the notification name as `_notification` metadata and calls the current runner. Errors are logged and swallowed by the context wrapper. Producers must not assume a successful HTTP response proves durable processing when notification fails. `resetThread()` delegates to the manager and refuses active threads.

`reloadPlugin()` stops the old instance with a five-second timeout and creates a new one. Its failure is recorded on that plugin rather than stopping other plugins. Definition rescanning is a boot operation; editing imported code is not an automatic hot-reload contract.

## 5. Runner and RPC hooks

| Interface | Responsibility |
|---|---|
| `AgentRunner.start()` | Recover interrupted rows, start worker loops, wake dispatch. |
| `notify()` | Persist an input and queue or steer it. |
| `pauseDequeue()` | Prevent new batch claims during a settings handoff. |
| `abort(threadId)` | Request explicit cancellation of an active batch. |
| `stop()` | Interrupt runs as shutdown attempts and wait for workers. |
| `batch-completed` | Manager callback for completing a pending settings reload. |
| `AgentDb.dequeueBatch()` | Transactionally claim a thread's rows; continuation/drain options control selection. |
| `setRowEntryId()` | Persist a row's first conversation-entry binding. |
| `markBatchDone/Failed/Cancelled()` | Finalize affected inputs; failure increments attempts and requeues when allowed. |
| `PiRpcClient.sendPrompt/Steer/Abort()` | Encode the supported child commands. |
| `onUserMessageStart`, `onHarnessEntry`, `onAgentEnd` | Delivery and completion observations used by the runner. |
| `waitExit`, `endStdin`, `killGroup` | Child teardown and descendant cleanup. |

The runner reads prompt fragments on every spawn and writes their assembled content to a file. Agent-fixed prompt values are baked by CLI scaffolding; the current thread/session path is appended at spawn. Skills are recursively loaded from the explicit skill root, and valid first-level extension entry points are passed individually.

RPC uses UTF-8 decoding and newline framing. The prompt acknowledgment deadline is 60 seconds, paused during reported preflight compaction. Interactive extension dialogs are cancelled. There is no general maximum streaming duration. Cleanup closes stdin, waits for actual exit, escalates after five seconds, and sweeps the process group before releasing the thread.

## 6. Operating the current server

| Task | Procedure |
|---|---|
| Add an agent | Run `cognisphere agent new <name>` in the app home/harness directory, configure its model, then restart the server to discover it. |
| Start/stop/restart an existing agent | Use its console controls or lifecycle API. |
| Enable an optional plugin | Create `agents/<id>/plugins/<pluginId>/config.json`, configure credentials, and restart the agent. Fork its definition with `cognisphere plugin add` only when customizing it. |
| Apply settings | Use settings APIs/console so they invoke the appropriate reload. Generic file writes do not trigger reloads. |
| Edit secrets on disk | Restart the server to construct fresh stores; alternatively use the secrets API, which invalidates the cache and reloads affected agents. A plain manual agent restart does not invalidate `SecretsStore` by itself. |
| Refresh dependencies | Edit the agent's bootstrap requirements and restart the agent; bootstrap runs on every start. |
| Inspect work | Read event status/error/attempts and follow session/entry links to the conversation. |
| Retry failed input | Use the failed-row requeue endpoint; it resends original text with a retry warning. |
| Reset a conversation | Delete the thread through the API after it is no longer active. This removes its events, binding, and session files. |

Use structured logs for lifecycle/process errors, event rows for input state, and session JSONL for model/tool history. `/healthz` only checks server availability and listed-agent count. Failed plugins, incomplete dependency installation, and blocked batches require their own inspection.

The server's temporary-file janitor removes known temp debris older than 24 hours at boot and every six hours; it does not prune durable agent history.
