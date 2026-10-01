# Phase 14: agent self-review

[Roadmap](../roadmap.md) · Previous: [Phase 13](phase-13-session-search.md) · Next: [Phase 15](phase-15-other-runtimes.md)

## Requirement

Agents get better over time. A periodic review of an agent's recent conversations reports:

- repeated work that deserves a skill;
- recurring failures;
- conflicting or unused prompts and skills;
- concrete proposed changes.

A person decides what to apply.

## Design

Almost no platform code is needed:

- **Review skill:** a `review-agent` skill, part of a capability given to `nova`. It uses `search-sessions` (phase 13), reads the target agent's `agent.json` selection and `assets.json`, and writes `workspace/reports/<agent>/<period>.md`. Each report contains evidence links (thread and entry IDs) and proposed new asset files and selection changes.
- **Schedule:** `schedule add --id weekly-review --cron …` (phase 7) with a handler that queues the review task.
- **Applying changes:** an approved proposal is applied by nova as an ordinary asset change in the target agent: a new file, a selection change in `agent.json` and an `assets.json` entry. Git and checkpoints (phase 11) provide rollback.

**Dropped from the old plan:** proposal records with evidence fingerprints, and the approved-application pipeline.

## Done when

- A manual run on a real agent produces a report whose evidence links open the right messages.
- A scheduled run for the same period overwrites the same report instead of creating duplicates.
- Docs: the skill's `SKILL.md`, shipped README.

## Open questions

1. Can any agent review itself, or only nova review others?
2. Should reports be delivered somewhere (for example by Telegram to the operator), or is a workspace file enough?
