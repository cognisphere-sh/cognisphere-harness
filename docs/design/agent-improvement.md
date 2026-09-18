# Agent improvement design

Status: planned after searchable history. Start with review-only reports, then add controlled application of approved changes.

## Flow

1. A scheduler creates a review task for a target agent and time window.
2. The reviewer reads authorized session evidence, failure patterns, and skill usage.
3. It writes a report and proposed edits under its workspace, with links to supporting sessions.
4. An operator reviews the proposal. Approved asset changes pass validation and become a new immutable release.
5. Future runs select the new release; outcome records support comparison and rollback.

The reviewer uses the same harness runtime, queue, and session infrastructure. It receives scoped access to the target's evidence rather than arbitrary write access to other agents.

## What to review

| Signal | Useful proposal |
|---|---|
| Repeated successful steps | A reusable skill or script. |
| Repeated tool failures | A tested correction to instructions or a helper. |
| Conflicting or duplicate skills | A consolidated procedure with preserved references. |
| Outdated notes | A source-backed memory correction. |
| Excessive context consumption | A smaller prompt or recall rule, validated against representative tasks. |

Each proposal includes the problem, evidence, exact diff, expected behavior, validation, and rollback target. Avoid arbitrary change quotas or automatic deletion based only on age. Mark generated claims as proposals until reviewed.

## Ownership

The [sandbox design](sandbox.md) keeps approved prompts, extensions, scripts, and dependency recipes immutable during execution. The reviewer may prepare drafts but cannot modify an active release, import workspace code as a trusted extension, or execute a host build directly. Agent-authored workspace skills and notes remain editable under the same writer coordination as other work.

The first release produces reports only. Later application uses the trusted release workflow and records which proposal produced each asset revision. Delivery criteria live in the [implementation roadmap](../roadmap.md#3-agent-improvement).
