# Memory

Cross-thread memory. One section per memory, separated by
`-----$-----$-----$-----`. Grep for what you need instead of reading the whole
file:

    grep -i -B2 -A10 '<term>' knowledge/memory.md

Format:

    name: <short-kebab-name>
    lastUpdated: YYYY-MM-DD HH:MM:SS
    description: What to remember, why it matters, where it came from, the
      reasoning behind it, and how long it stays relevant.

**What belongs here: episodic events and facts** — what happened, what was
found, what is true. **Procedural guidance does not.** A rule about *how to do
something* goes in `system_prompts/1-agent.md` if it holds everywhere, or in the
skill for the procedure it governs if it only applies there. If you catch
yourself writing "always…" or "never…" into a memory, it belongs in one of those
two places instead.

-----$-----$-----$-----

