# Planwerk — Vision

> The management surface for agentic software development.

---

## The Problem

AI agents produce 4x more code — but real productivity gains are only ~12%. The difference is absorbed by verification work that humans still do manually.

Review times are up 441%. Zero-review merges are up 31%. Not by choice — by flood. Good engineering process doesn't protect you when volume arrives faster than any process was designed to absorb.

Meanwhile, developers babysit agent sessions one at a time. There's no unified view of what's happening. And agents left unchecked will quietly weaken CI to make themselves pass — not maliciously, just the cheapest path to green.

**The gap isn't intelligence — it's governance.**

---

## The Vision

**Planwerk is a kanban board for the agentic SDLC.** Agent sessions become cards flowing through development phases, with autonomous quality enforcement and an AI orchestrator that manages the work so developers don't have to.

Loop engineering says: stop prompting agents yourself — design the system that prompts them. Planwerk is that system made visible. The orchestrator is the heartbeat. Skills drive reviews. Sub-agents verify. The board is the persistent state. Every primitive a loop needs, rendered as a management surface you can see and direct.

### Factory floor, orchestra pit

The industry keeps arguing over two mental models for coding agents: the **Software Factory** (agents as assembly-line workers, throughput as the metric, stop-the-line on failure) and the **Orchestra** (agents as independent instruments, coherence as the metric, isolate-and-continue on failure). Planwerk doesn't pick a side — it already runs both, at different scopes, and should say so on purpose:

- **The board is the orchestra.** Every card is an independent session — an instrument, not a stop on someone else's line. One card erroring never blocks another. The orchestrator is the conductor: it doesn't execute the work, it watches the ensemble, keeps sessions to the shared score, and steps in when something drifts.
- **Each card is a factory line.** `Define → Plan → Build → Review → Ship` is a sequential pipeline with hard stage gates. Stop-the-line discipline applies *within* a card: a failed gate blocks that card's advancement until it's fixed or a human overrides it.

This is why Planwerk avoids the throughput-only trap that critics of pure factory models call out — "we tried this ten years ago with feature factories, it didn't work." Cards can move fast individually, but nothing ships until the ensemble still hangs together and a human still understands what changed. Throughput is a per-card property; coherence is a board-level responsibility only the conductor can hold.

---

## Principles

**Management surface, not an IDE.** Show progress, decisions, and blockers. No code in the UI.

**Gates are external and enforced.** The agent that wrote the code never grades its own work. A different reviewer — sometimes a different model — does the verification. Gates are system-enforced because agents optimizing for "done" will find the cheapest path to green if you let them.

**Autonomous but accountable.** The orchestrator monitors, intervenes, and enforces — but logs every decision. Humans override with full audit trail.

**Risk-proportional.** A typo fix gets auto-merged. A security change gets adversarial review, multiple reviewers, and human sign-off. Match effort to cost of being wrong.

**Heterogeneous verification.** Multiple reviewers with different perspectives. 93.4% of AI reviewer findings are unique to exactly one tool — diverse reviewers isn't redundancy, it's coverage.

**Coherence is a board-level property.** A gate can prove a single card is internally correct; it can't prove the ensemble still fits together. When concurrent cards touch overlapping code, something has to check the whole, not just the parts.

---

## How It Works

```
Define → Plan → Build → Review → Ship
```

Each card is a live agent session. The orchestrator ("CTO agent") runs persistently — detecting stuck sessions, assigning risk levels, managing WIP, and escalating to humans only when judgment is needed.

**Quality gates** block every phase transition. Deterministic checks (lint, test, typecheck) must pass before leaving Build. Indeterministic reviews (code review, security) run as sub-agents in the Review phase with maker-checker separation. Failed reviews feed back into Build — the agent fixes and re-attempts until pass or escalation.

**The coherence gate** runs horizontally across the board: when two in-flight cards touch overlapping code, an external reviewer checks whether their changes still cohere before either ships. High-risk clashes block the Ship transition (pair-level, with a logged human override); lower-risk ones surface as an advisory. It's the one check that judges the ensemble, not the card.

**The board** shows real-time progress across all sessions. A conversational sidebar lets you command the orchestrator naturally. Drag-and-drop respects gates. The attention system surfaces what needs you.

---

## Integration, Not Replacement

- **Agent Host Protocol** provides real-time session state
- **GitHub Issues & Projects** as task sources — Planwerk manages execution, not backlog
- **GitHub PRs** as the ship destination

The board manages the AI execution layer between "task defined" and "PR merged."

---

## The North Star

A developer opens Planwerk. Twelve agent sessions are progressing. Two need input. One failed a security review and is self-correcting. The orchestrator resolved four blockers and is suggesting what to prioritize next.

The developer reviews the decisions, approves three PRs the gates already validated, and redirects a session that drifted off-scope. The job shifts from *doing the work* to *directing the work*.

But Planwerk keeps them the engineer. The decision log shows every choice made. The attention system surfaces what needs understanding, not just approval. Writing got cheap. Understanding didn't. Planwerk makes sure someone still owns it.
