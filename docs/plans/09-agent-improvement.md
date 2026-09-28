# Plan 3: agent improvement

**Status:** later planned feature. **Delivery:** M14 review-only reports, M15 approved application. [Roadmap](../roadmap.md#3-agent-improvement). **Depends on:** [read-only session search](08-session-search.md) for evidence; M8 for scheduling if used; M11's [publication workflow](10-agent-simplification.md) and applicable [migration checks](07-protection-and-cutover.md) for application. Manual review runs can ship first.

## Review-only reports

An ordinary scoped agent run examines authorized existing Pi session entries, trusted event/operation outcomes and selected work files. It produces evidence-linked reports and optional exact draft diffs. This does not introduce a memory service, automatic recall or a session archive; the reviewer reads existing files and never rewrites Pi history.

Record each proposal's target, base asset release or expected file hashes, source file/session/entry IDs and content fingerprints, exact diff, validation result, trusted review decision and rollback release. Evidence may change or disappear as Pi files evolve; revalidate sources before claiming they still support a proposal and show missing evidence explicitly. Do not silently manufacture an archived source copy.

1. Gather bounded evidence for the authorized agent/window. Separate observations from inferred causes and report missing data.
2. Identify repeated workflows, conflicting skills, common failures and unnecessary context. A report need not propose a change.
3. Write a report/draft under the reviewer's agent-managed directory, citing original source identities and hashes.
4. Keep M14 review-only. A manual trigger uses the normal queue/runtime; after M8, schedule the same task with a stable target/window/policy identity to deduplicate retries.

Example:

```text
Proposal: support-skill-17
Evidence: support / Pi-session-A / entry-U9, verified content fingerprint H1
Base: asset release a12
Change: exact diff adding a bounded CSV-cleanup skill and example
Validation: representative CSV tasks plus malformed input
Decision: pending review; active release remains a12
Rollback: select a12 after stopping any newer runtime generation
```

Ordinary own-directory prompt/skill customization and authorized script publication from plan 1.8 are independent of this later evidence-driven review workflow.

## Approved application

M15 requires a trusted decision for the exact diff/base and successful validation. Agent-authored code cannot acquire host/build authority merely by calling itself an improvement. Publish assets as new immutable releases; activate through drain, confirmed stop and replacement without overlapping agent runtimes.

For agent-managed files, acquire the target's writer gate, reread current content, compare expected hashes, apply safely and record the result. No mandatory workspace snapshot or checkpoint service is added. If validation, authority or expected content fails, preserve the active release/files and return the proposal for revision.

Rollback of a base/image release selects the recorded prior release through the same controlled lifecycle. It does not undo later work files or external actions. Reverting a specific work-file edit needs its explicit reviewed inverse/content checks; broader filesystem recovery uses operator backup tooling and must preserve newer trusted queue/operation outcomes.

## Acceptance

M14: source-linked reports are useful and scoped, stale/missing evidence is visible, retries do not duplicate a scheduled review and active resources remain unchanged. Search/index failures do not affect Pi execution.

M15: only the validated exact diff/base activates; stale approval or failed build cannot publish; shared file edits serialize; release provenance and exclusive rollback are recorded. Verify model/task outcomes before claiming an improvement in quality. Record evidence in the roadmap, not as a second status tracker here.
