# create-plugin — changelog

## 1.2.0

- Description now states what the skill covers and *when a plugin is the right
  answer* (external service, HTTP endpoint, schedule, agent-facing CLI over
  harness-side state) instead of only listing trigger phrases — the description
  is all an agent sees before deciding to read the skill.
- §2 documents shipping a skill inside a plugin's seed
  (`seed/skills/<id>/<slug>/`): where the prompt fragment ends and a procedure
  begins, versioning/changelog per `create-skill`, and plugin-ownership of the
  scope dir. `artifacts`/`publish-artifact` is the worked example.

## 1.1.0

- Current shipped version (changelog introduced retroactively with the
  skill-versioning convention; version now also stated in the description).

## 1.0.0

- Initial version: scaffold `plugins/<id>/index.ts` + seed tree, enable on
  an agent, verify load/start.
