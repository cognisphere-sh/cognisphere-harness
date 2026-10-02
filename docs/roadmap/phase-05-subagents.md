# Phase 5: sub-agents

[Roadmap](../roadmap.md) · Previous: [Phase 4](phase-04-core-prompt-and-capabilities.md) · Next: [Phase 6](phase-06-agent-host-split.md)

## Requirement

- **Specialist roles:** an agent can have specialist roles such as "browser" or "researcher". Each has its own model, tools, prompts and skills, works on the same files, and keeps its own conversation history.
- **Delegation:** the main agent hands a task to a role. The result comes back into the parent conversation, which then continues.
- **Durability:** nothing is lost across restarts, a result never wakes the parent twice, and the parent never waits inside a turn.

**Today:** the base prompt already teaches "task threads": the agent messages itself on `<ThreadId>-§-[TASK]-§-<slug>`, and the task thread reports back with `agent-msg send`. Every task thread uses the same model and prompt as the main agent, and reporting back relies on the model remembering to do it.

## Design

**Everything about a role lives in `agent.json`:**

```json
"subagents": {
  "browser": {
    "description": "Browses websites and returns findings with source links.",
    "model": { "provider": "openai", "id": "cheap-model", "thinkingLevel": "low" },
    "capabilities": ["browser", "notes"],
    "tools": ["read", "bash", "write"],
    "prompts": ["base/prompts/core-subagent.md", "base/capabilities/browser/prompts/task.md"],
    "skills": ["base/capabilities/browser/skills/browse"]
  }
}
```

- **Configuration:** `description`, `model`, `capabilities` and `tools` are operator-only. `prompts` and `skills` are selection fields, which the agent may change through the `assets` CLI with `--role browser` when `allowAssetChanges` is on (phase 3). Assets the agent writes for a role are explained in `assets.json` like any other asset.
- **Defaults:** `model` defaults to the agent's model. `capabilities` must be a subset of the agent's.
- **Delegation fragment:** the main role's prompt gains a generated fragment listing each sub-agent's name and description.

**Delegation reuses task threads:**

1. **Delegate:** the parent runs `delegate <role> "<brief>"`, which is part of the `task-threads` capability.
2. **Record the task:** the harness creates a `tasks` row (`id, role, parentThreadId, childThreadId, status`). The child thread is `<parentThreadId>-§-[TASK]-§-<role>-<id>`. The harness queues the brief on that thread with the role attached. The CLI prints `task <id> accepted`, and the parent ends its turn.
3. **Run the child:** the runner starts the child batch with the role's model, tools, prompts and skills. With one active turn per agent, the child runs after the parent's turn ends.
4. **Return the result:** when the child's batch finishes, the harness posts the child's **final assistant message** to the parent thread as `Result of task <id> (<role>): …`. It uses `sourceKey = task:<id>:result` from phase 2, so a retry can't post it twice. The model doesn't have to remember to report back. Take the last `assistant` message from the batch's last `agent_end`. Since Pi 0.99, `agent_end.messages` starts with the `role: "system"` message, so never take the first entry or count positions from the start.
5. **Failure:** the parent receives `Task <id> (<role>) failed: <reason>`.
6. **Cancellation:** cancelling the parent thread also cancels its queued or running child tasks.
7. **Follow-ups:** `delegate --task <id> "<more>"` continues the same child thread, keeping its history.

**Limits:** a sub-agent can't delegate further, and doesn't get messaging or user-channel capabilities unless they're listed. Roles are for focus and cost, not security: a role with `bash` can still read every file in the agent folder.

Plain task threads with no role keep working as today, using the main agent's setup.

## Done when

These scenarios pass as phase 1 tests with fake Pi:

- delegating runs the child with the role's model and prompt, and the parent receives the result once;
- after a restart while the child is queued, and again while it's running, the parent still receives the result exactly once;
- a failed child sends a failure message to the parent;
- cancelling the parent cancels the child;
- a sub-agent that tries to delegate is rejected.

Also:

- **Validation:** unknown capabilities, missing asset files and unusable models produce clear errors.
- **Console:** task threads appear under their parent.
- **Docs:** agents.md, core.md (`tasks`, result posting), the `task-threads` skill, shipped README.

## Open questions

1. **Unusable sub-agent model:** if a sub-agent's model can't be used at run time, should the task **fail** (suggested, because silent cost or quality changes in delegated work are worse) or **fall back** to the agent's model, as threads do?
2. **Result shape:** is the result always the child's final message, or should the child be able to attach files and paths explicitly (a `report` script)?
3. **Batching results:** several results arriving while the parent is idle are batched into one parent turn by the existing queue. Is that the desired behavior?
