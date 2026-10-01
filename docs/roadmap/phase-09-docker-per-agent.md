# Phase 9: Docker per agent

[Roadmap](../roadmap.md) · Previous: [Phase 8](phase-08-storage-interface.md) · Next: [Phase 10](phase-10-secrets-broker.md)

## Requirement

- **One container per agent:** each agent can run in its own container, holding its agent host, its Pi and everything its capabilities need. Inside, it can reach only its own state, its granted shared folders, the network and the coordinator. It can't reach the host, other agents or the coordinator's data.
- **Persistence:** files and history survive container restarts and rebuilds.
- **Packages:** agents can install pip and npm packages that persist. By default an agent has no root. A per-agent flag gives root, so the agent can `apt install` something it needs for the current task.
- **Switching back:** returning to a plain process is one setting.

## Design

### Images

| Layer | Contains | Rebuilt when |
|---|---|---|
| `cognisphere-runtime:<v>` | OS, Node, Python, `uv`, pinned Pi, `cognisphere agent-host` | Harness upgrade |
| `cognisphere-base:<v>` | `FROM runtime` plus the base folder at `/opt/cognisphere/base` (core prompts and every capability's files) | Harness upgrade or deployment fork change |
| `cognisphere-agent-<id>:<hash>` | `FROM base` plus the selected capabilities' dependencies: system packages in one layer, **one Python venv** at `/opt/agent/venv`, and **one Node environment** at `/opt/agent/node_modules`, each holding every selected capability's packages | Capability selection or any dependency file changes |

**Collisions:**

- **System packages** are installed together. A real conflict fails the build with a clear message.
- **Python:** all selected capabilities' requirements are resolved together (`uv pip compile`). If two capabilities need incompatible versions, the build fails and names both capabilities. The fix is to change a pin in one of them or drop one.
- **Node:** the same, with one merged `package.json` resolved by npm.
- **Command names:** two capabilities shipping the same command name fail the build.

**Builds:** `cognisphere image build [<agent>]` builds the images. The coordinator rebuilds an agent's image automatically when its capability selection changes, then restarts the unit when it's idle.

### Container

```text
docker run -d --name cs-<harnessId>-<agentId> --label cognisphere.agent=<id>
  --read-only --tmpfs /tmp --user <uid>:<gid> --cap-drop ALL --pids-limit … --memory …
  <mounts from AgentStorage: assets (rw, or ro when allowAssetChanges=false), workspace, plugin-data, deps, sessions, .runtime, /shared/...>
  -e COGNISPHERE_UNIT_TOKEN=… -e COGNISPHERE_URL=…
  cognisphere-agent-<id>:<hash>  cognisphere agent-host <id>
```

- **Long-running:** the container stays up. The unit's lifecycle is phase 6's, and Pi is a child process inside.
- **One container per agent:** the fixed `--name` means Docker refuses a second container for the same agent. At boot, the coordinator removes any leftover container with that name and label.
- **Base folder:** at start, the agent host points `assets/base` at `/opt/cognisphere/base`. In process mode it points at the host's base folder instead. Either way it's recreated on every start, so switching runtimes is safe.
- **Reaching the coordinator:** containers connect to `COGNISPHERE_URL`, for example `http://host.docker.internal:<port>`. On Linux this needs `--add-host=host.docker.internal:host-gateway` and the coordinator listening on the bridge address.
- **Not mounted:** `.secrets/`, other agents, the coordinator database, the host's `HOME`, the Docker socket.

### Installs

From the agent's point of view there is **one Python and one Node environment**, which already holds every capability's packages and accepts its own installs.

- **pip:** `deps/.venv` is a small venv created inside the container on top of the image venv (`--system-site-packages`). The agent's `python` and `pip` come from it, so it sees every capability package. Plain `pip install` and `uv pip install` add packages there, and they persist on the state volume. The venv is recreated automatically if the runtime's Python version changes.
- **npm:** `npm install -g` uses the prefix `deps/node`, and `deps/node/bin` is on `PATH`. `NODE_PATH` lists `deps/node/lib/node_modules` first, then `/opt/agent/node_modules`.
- **Capability scripts** run with the image environment directly (shebang `/opt/agent/venv/bin/python`). They see the capability packages but not the agent's own installs, so an agent upgrading a package for its own work can't break a capability script.
- **apt:** with `"sandbox": { "root": false }` (the default), `apt` isn't available.
- **Root agents:** with `"sandbox": { "root": true }`, the container runs as root with a writable root filesystem, so `apt install` works immediately in the same session. Those packages last until the container is recreated (restart, rebuild, upgrade). The capability instructions tell root agents to also record such packages in `assets/install/apt.txt`, so the next image build includes them (open question 2).

### Switching

- **The setting:** `agent.json → "runtime": "process" | "docker"`. The default stays `process`, labeled `[no sandbox]`.
- **Switching:** restarts the unit. The state folders are the same either way.

## Done when

- **Isolation:** a Docker agent completes real turns, events and handlers. From inside, `../`, other agents, `.secrets/` and the host's `HOME` are unreachable. `assets/base` and `agent.json` are read-only.
- **Persistence:** `pip install` and `npm i -g` survive a container restart.
- **Root flag:** a non-root agent can't run `apt`, and a root agent can.
- **Recovery:** killing the container during a turn causes a restart and retry with history intact. A leftover container from a crash is removed at boot.
- **Image rebuilds:** enabling `browser` triggers an image rebuild, and the next batch can use Chromium. Disabling it removes Chromium from the next image.
- **Switching back:** setting `runtime` back to `process` works with no folder changes.
- **Docs:** HLD (sandbox boundary), core.md, agents.md (`runtime`, `sandbox.root`, `deps/`), cli.md (`image build`), shipped README (enabling it, and what is and isn't protected; secrets are still environment variables until phase 10).

## Open questions

1. **Truly single environment?** Should the agent's own installs go into the *same* environment that capability scripts use? The suggested layering keeps capability scripts on the image environment, so an agent's `pip install -U requests` can't break them. A truly single writable venv would have to live on the state volume and be rebuilt from capability requirements at container start, which is slower and fragile.
2. Which platform comes first: Linux, macOS Docker Desktop, or both? This affects the coordinator address and file ownership on Linux bind mounts.
3. For root agents: should `assets/install/apt.txt` be baked into the next image automatically, or only after operator approval?
4. Should resource limits (CPU, memory, pids) be set per agent in `agent.json`, or as one harness-wide default?
5. Should the console show image build logs and an "image out of date" badge per agent?
