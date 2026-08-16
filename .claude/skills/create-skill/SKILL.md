---
name: create-skill
description: Author or update a versioned skill for a CogniSphere agent — capture a procedure (SOP, runbook, workflow) as skills/agent/<slug>/ with SKILL.md, version, changelog, scripts and artifacts. Covers the skill layout, the description spec (summary + contents + when-to-use + version), creating, updating/bumping, and verification. Use when asked to "create a skill", "add a skill to <agent>", "turn this SOP into a skill", "migrate this procedure to a skill" or "update/bump a skill" — and whenever a multi-step procedure is being written down for reuse, re-derived from scratch a second time, or found inlined in a prompt file or knowledge/ where it doesn't belong. (v1.2.0)
metadata:
  author: cognisphere
  version: "1.2.0"
  argument-hint: <agent-id> <skill-slug>
---

# Create or update an agent skill

Skills are an agent's **procedural memory**: every step-by-step procedure
lives as a skill under `agents/<agent-id>/skills/agent/<slug>/` — never
inlined in `system_prompts/` (identity/behaviour only), `knowledge/`
(reference facts only), or workspace notes. pi loads each skill at spawn and
injects its name, description, and location into the system prompt, so the
description is the only thing the agent sees before reading `SKILL.md`.

## Layout

```
agents/<agent-id>/skills/agent/<slug>/
├── SKILL.md        ← frontmatter + the procedure
├── CHANGELOG.md    ← one entry per version, newest first
├── scripts/        ← (optional) helper scripts the procedure invokes
└── artifacts/      ← (optional) templates, examples, reference files
```

A skill is self-contained: everything the procedure needs lives inside its
directory, referenced from `SKILL.md` by skill-relative paths. Don't put a
skill's scripts in `scripts/agent/` or its files in the workspace.

`skills/<plugin-id>/` scopes are plugin-owned (reseeded on every agent
start) — never author or edit skills there.

## Creating a skill

1. Pick a short kebab-case `<slug>` naming the procedure.
2. Write `SKILL.md`:

```markdown
---
name: <slug>
description: <summary of what it does>. Covers <what's included: the procedures, topics, scripts and artifacts inside>. Use when <trigger phrases / task shapes>. (v1.0.0)
metadata:
  author: <who>
  version: "1.0.0"
---

# <Title>

<the procedure: prerequisites, numbered steps, verification, failure modes>
```

   The description is the only thing the agent sees before deciding to read
   `SKILL.md`, so it must carry four things:

   - **Summary** — what the skill does, one line.
   - **What's included** — the procedures, topics, scripts and artifacts it
     covers. A skill is often only *partially* relevant to a task; listing
     its contents is how the agent knows one section applies.
   - **When to use it** — trigger phrases / task shapes to match against.
   - **Version** — `(vX.Y.Z)`, matching `metadata.version`; the description
     version is what makes updates visible to a running agent.

   `metadata` carries `author` and `version`.
3. Move helper scripts into `scripts/` (keep them executable) and
   templates/reference files into `artifacts/`; reference both by
   skill-relative path from `SKILL.md`.
4. Start `CHANGELOG.md`:

```markdown
# <slug> — changelog

## 1.0.0

- Initial version: <one line on what the procedure covers>.
```

5. If the procedure came from a prompt file or `knowledge/SOPs/`, delete it
   there and update `1-agent.md` to *reference* the skill (when to reach for
   it), not restate its steps.

## Updating a skill

1. Edit `SKILL.md` (and `scripts/`/`artifacts/` as needed).
2. Bump the version — semver: correction = patch, changed/added steps =
   minor, incompatible rewrite = major — in **both** `metadata.version` and
   the description text. They must always match.
3. Add a `CHANGELOG.md` entry: what changed and why, newest first.

The version bump is not optional: agents compare the version advertised in
their prompt against the copy they last read, and only re-read `SKILL.md`
when it moved.

## Verify

No harness restart is needed — pi re-reads the skills directory on each
session spawn, so the skill appears in the agent's `<available_skills>`
block on the next spawned session (or ask the agent to list its skills).
Constraints (pi drops or warns otherwise): frontmatter must parse and
`description` is required — a skill without one is skipped; `name` is
lowercase kebab-case, ≤ 64 chars (falls back to the directory name if
omitted); `description` ≤ 1024 chars.
