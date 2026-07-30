# Harness documentation

Documentation for **this deployment's** harness data dir (`harness/`): its
agents and user-space plugins. Owned by whoever changes the code — the
developer agent or a human — and updated **after every change** under
`harness/` (see `CLAUDE.md` §7). How the harness platform itself works is
documented in [`../base-harness/`](../base-harness/README.md).

Suggested layout: one file per agent (`agent-<id>.md` — purpose, persona,
installed plugins, secrets it needs, thread strategy) and one per user-space
plugin (`plugin-<id>.md` — what it integrates, config, seeded scripts).

## Agents

- the developer agent (`nova`, shipped with the home). Owns and modifies this
  home's code and keeps these docs current; reachable from other agents via
  agent-messaging (human channels are opt-in plugins).

## Plugins

_None forked yet._
