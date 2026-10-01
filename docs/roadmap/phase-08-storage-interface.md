# Phase 8: storage interface

[Roadmap](../roadmap.md) · Previous: [Phase 7](phase-07-events-and-handlers.md) · Next: [Phase 9](phase-09-docker-per-agent.md)

## Requirement

- **One storage interface:** an agent's state (assets, workspace, plugin data, deps, sessions) lives on storage reached through one interface. This lets the same agent run as a process, as a container, and later on other machines.
- **Backends:** local disk now, JuiceFS next (phase 11). Not every backend has to support checkpoints.
- **Cloning without state:** an agent can be copied *without* its state, as a fresh agent with the same definition.
- **Shared folders:** agents can share folders with each other, with access set per agent.

## Design

```ts
interface AgentStorage {
  readonly capabilities: { checkpoints: boolean; multiHost: boolean };
  ensure(agentId: string): Promise<void>;                          // create the state folders (phase 3 layout)
  mounts(agentId: string, shared: SharedGrant[]): MountSpec[];     // host path → unit path, ro/rw
  remove(agentId: string): Promise<void>;
  checkpoint?(agentId: string, label: string): Promise<string>;    // phase 11
  listCheckpoints?(agentId: string): Promise<CheckpointInfo[]>;
  restore?(agentId: string, id: string): Promise<void>;
}
```

**`LocalDiskStorage`:** the agent's state is in `<harnessRoot>/agents/<id>/`, as today, and shared spaces are in `<harnessRoot>/shared/<space>/`.

- **Process units:** use the paths directly, which is unchanged.
- **Docker units (phase 9):** turn `mounts()` into `-v` flags.
- **Checkpoints:** not supported on local disk, so `capabilities.checkpoints = false`.

### Definition vs. state

| Definition: copied by `agent clone` | State: never copied by `clone` |
|---|---|
| `agent.json`, `plugins/<pid>/config.json` | `assets/` (except `base`), `workspace/`, `plugin-data/`, `deps/`, `sessions/`, `.runtime/` |

- **`cognisphere agent clone <src> <new>`:** copies the definition and builds fresh state. Any selected path that points at an agent-made asset (`prompts/…`, `skills/…`) is reset to the base defaults for the selected capabilities, because those files aren't copied.
- **`--with-assets`:** also copies the source's `assets/`, including `assets.json`, and keeps the selection as it is, which is useful for templating a tuned agent.

### Shared folders

- **Granting:** operator config in `agent.json` grants access, for example `"shared": [{ "space": "research", "mode": "rw" }]`. The space appears at `/shared/research`.
- **Avoiding write conflicts:** in `rw` mode the agent writes only into `/shared/<space>/<agentId>/` and reads everything. Each writer has its own subfolder.
- **Enforcement:** none for process units, which are labeled `[no sandbox]`. Mounts enforce it for Docker units from phase 9.

## Done when

- Process units get their folders from `AgentStorage`, with no hard-coded paths left in the agent host.
- `agent clone` produces a working agent with no workspace, sessions or plugin data. `--with-assets` carries over prompts, skills and the log.
- Two agents with a shared `research` grant can exchange a file through their subfolders.
- Docs: core.md (storage), agents.md (definition vs. state, shared spaces), cli.md (`clone`), shipped README.

## Open questions

1. Should local disk offer cheap checkpoints too, using `rsync --link-dest` (unchanged files are hard-linked, and no new dependency is needed)? Otherwise checkpoints wait for JuiceFS.
2. Are shared-space grants operator-only, or can an agent invite another agent?
