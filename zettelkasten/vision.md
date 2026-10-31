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

The coordinator is the developer's chief of staff. Give it a goal and acceptance criteria; it delegates work to scoped sessions, follows results, and brings back decisions that need human judgment. Worker sessions implement. Independent reviewers verify. The developer retains authority over what ships.

Loop engineering says: stop prompting agents yourself — design the system that prompts them. Planwerk is that system made visible. The orchestrator is the heartbeat. Skills drive reviews. Sub-agents verify. The board is the persistent state. Every primitive a loop needs, rendered as a management surface you can see and direct.

### Factory floor, orchestra pit

The industry keeps arguing over two mental models for coding agents: the **Software Factory** (agents as assembly-line workers, throughput as the metric, stop-the-line on failure) and the **Orchestra** (agents as independent instruments, coherence as the metric, isolate-and-continue on failure). Planwerk doesn't pick a side — it already runs both, at different scopes, and should say so on purpose:

- **The board is the orchestra.** Each card is a separate session. A failed card does not halt the board, but dependent goal work must wait for its prerequisites. The coordinator delegates and follows the ensemble rather than implementing the work itself.
- **Each card is a factory line.** `Define → Plan → Build → Review → Ship` is a sequential pipeline with hard stage gates. Stop-the-line discipline applies *within* a card: a failed gate blocks that card's advancement until it's fixed or a human overrides it.

This is why Planwerk avoids the throughput-only trap that critics of pure factory models call out — "we tried this ten years ago with feature factories, it didn't work." Cards can move fast individually, but nothing ships until the ensemble still hangs together and a human still understands what changed. Throughput is a per-card property; coherence is a board-level responsibility only the conductor can hold.

---

## Principles

**Management surface, not an IDE.** Show progress, decisions, and blockers. No code in the UI.

**Gates are external and enforced.** The agent that wrote the code never grades its own work. A different reviewer — sometimes a different model — does the verification. Gates are system-enforced because agents optimizing for "done" will find the cheapest path to green if you let them.

**Autonomy is an explicit grant.** The coordinator observes by default. Operators can grant verification authority or full coordination board-wide and override it per session. Every grant and autonomous action is visible and auditable.

**Risk-proportional.** A typo fix should need less review than a security change. Match effort to the cost of being wrong. Automatic merge is not a shipped coordinator capability.

**Heterogeneous verification.** Multiple reviewers with different perspectives. 93.4% of AI reviewer findings are unique to exactly one tool — diverse reviewers isn't redundancy, it's coverage.

**Coherence is a board-level property.** A gate can prove a single card is internally correct; it can't prove the ensemble still fits together. When concurrent cards touch overlapping code, something has to check the whole, not just the parts.

---

## How It Works

```
Define → Plan → Build → Review → Ship
```

Each card is a live agent session. The coordinator runs persistently at one of three authority levels:

- **Observe** labels risk and surfaces blockers without starting work or touching sessions.
- **Verify** also runs configured checks and report-only independent reviews, but does not respond to or advance managed sessions.
- **Coordinate** may interact with sessions and advance phases after the existing risk, gate, WIP, and approval policies allow it.

Observe is the safe board default. Individual sessions may inherit that default or carry an explicit override. These levels govern coordinator actions in chat and in the background. Asking in chat does not bypass mode, scope, risk, or gate checks. Direct human controls remain separate; a human can still answer input, request work, or initiate a gated phase move in any mode.

### Goal-driven coordination

The operator sets a goal, acceptance criteria, and workspace scope in chat. The coordinator persists the goal and dependent work. With Coordinate authority, it can create real worker sessions or delegate to known sessions on the connected host. The existing heartbeat follows their results.

A worker becoming idle or a message entering its queue is not completion. Follow-through requires a captured outcome tied to the delegated chat and turn, independent acceptance of the result, and current gates where verification is required. Reads expose the latest captured outcome, not a full conversation. Missing, truncated, unrelated, or uncertain evidence requires inspection instead of a guessed result or a blind retry.

The drawer shows goal progress and controls; the inbox surfaces completed goals and decisions that need a person. Pausing, cancelling, disconnecting, losing scope, or downgrading authority stops future follow-ups. It does not undo commands that workers already accepted. Saved goals survive reconnects, but persistence does not grant permission to continue.

Goal completion means acceptance criteria were met. It is separate from a card's SDLC phase and does not imply a merge or deployment.

### Verification and oversight

**Quality gates** block every phase transition. Before leaving Build, deterministic checks (lint, test, typecheck, build) and an independent implementation reviewer establish correctness and architectural soundness with maker-checker separation. Failed implementation reviews feed back into Build — the agent fixes and re-attempts until pass or escalation.

The Review phase is the human handoff, not the first correctness check. It synthesizes the original intent in `plan.md`, the final implementation, and prior gate evidence into a durable sibling `review.md`. That artifact records what was implemented, how it was validated, where reality diverged from intent, what still needs human attention, and whether the change is ready to ship. Ship remains blocked until the review assessment passes and the artifact is readable.

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
