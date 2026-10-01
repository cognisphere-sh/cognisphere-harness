# Phase 15: other runtimes (future)

[Roadmap](../roadmap.md) · Previous: [Phase 14](phase-14-agent-self-review.md)

## Requirement

- **Remote hosts:** agent units can run on other machines.
- **Short-lived sandboxes:** units can run in short-lived sandboxes (e2b, Vercel Sandbox, Modal). These wake for work, run, and are destroyed, so idle agents cost nothing.

## Why earlier phases already allow this

- **Triggers:** every trigger (timers, webhooks, Telegram, messages) is received by the coordinator and kept in the outbox (phases 6–7).
- **Connections:** units connect out over one authenticated WebSocket (phase 6), so NAT and firewalls are fine.
- **Secrets:** no secrets live in the unit (phase 10).
- **Storage:** state is behind `AgentStorage`, and JuiceFS works across machines (phases 8 and 11).

## Design sketch (to be detailed when scheduled)

- **Lifecycle setting:** `agent.json → "lifecycle": "always_on" | "idle:<minutes>" | "per_batch"`. With anything other than `always_on`, the coordinator starts the unit when its outbox has events, and the unit exits when its events and queue are empty.
- **Remote Docker hosts:** a `RemoteDockerLauncher`, using the Docker API over SSH or TLS, with JuiceFS mounted on each host.
- **Short-lived sandboxes:** a `SandboxLauncher` per provider. State comes either from a JuiceFS mount inside the sandbox (one volume per agent, so credentials stay scoped) or from syncing state in at start and out at exit (no live shared folders).
- **Cost guard:** one wake handles all queued events and messages before exiting. A minimum idle time prevents a wake for every message.

## Open questions

1. Which provider comes first, and does it support FUSE (needed to mount JuiceFS) inside the sandbox?
2. What cold-start time is acceptable for chat channels like Telegram? This decides between `idle` and `per_batch` for chat-facing agents.
