# Product Ideas Backlog — For Later Inspiration

> Not a sprint plan. A parking lot for product ideas worth revisiting — some sparked by the AIEWF 2026 "Factory vs. Orchestra" research (2026-07-07), some already implied by [vision.md](./vision.md) / [architecture-and-design.md](./architecture-and-design.md) but never turned into a feature. See [review-backlog.md](./review-backlog.md) for implementation bugs/gaps instead — this file is about *what to build next*, not *what's broken*.

---

## A. New ideas from the Factory vs. Orchestra research

Context: AIEWF 2026 framed coding-agent tooling as a split between **Factory** (pipeline, throughput, stop-the-line) and **Orchestra** (independent instruments, coherence, isolate-and-continue). Planwerk already runs both — board level = orchestra, card level = factory (see vision.md). These ideas fill the gaps that split exposes.

### A1. Coherence Gate (cross-card conflict/drift detector)
**Status:** ✅ Implemented (v1) — board-scoped `coherence-engine.ts`, async external reviewer, hybrid pair-level ship-blocking, "Accept divergence" resolution. See architecture-and-design.md §8. Remaining follow-ups: full multi-file semantic diff, cluster (>2-card) modeling, dependency-graph signal (B2).
**Why:** Gates today only check a card's own diff. Two concurrent cards editing the same module can silently diverge and nothing catches it before Ship — this is exactly the failure mode "throughput-only" critics point at.
**Idea:** A reviewer sub-agent that runs when ≥2 in-flight cards touch overlapping files/modules. Compares their diffs and decisions, flags architectural drift or conflicting approaches, and can block Ship on either card until resolved or a human accepts the conflict.
**Reuse:** Existing `changesetRef`/file-list tracking in `gate-engine.ts` and `review-executor.ts` already knows which files each card touched — the overlap detection is mostly a join, not new plumbing.

### A2. Autonomy Ratio metric
**Why:** The research's sharpest number is a benchmark (industry avg 17–19x human:agent actions, best-in-class ~35x). A management surface should own this metric, not leave it to anecdote.
**Idea:** Compute human actions (manual overrides, chat commands, DnD overrides, input answers) vs. agent actions per card and board-wide. Surface in the health bar with the industry line as a reference, and per-card in the detail modal.
**Reuse:** Orchestrator already logs every decision/override to the feed/audit trail (`heartbeat.ts` actions, `board-context.ts`) — this is a rollup query, not new instrumentation.

### A3. Governed Shared Score (human-authored-only project context)
**Why:** Research finding: LLM-edited context files reduce agent success ~3% and increase inference cost 20%+. `.github/planwerk.yml` today is config, not a living, versioned context doc all sessions consume.
**Idea:** Promote project context (conventions, architectural decisions, "don't touch" zones) into a versioned artifact visible in the UI. Enforce/flag if an agent session attempts to edit it. Show diff history + "last edited by [human]" badge.
**Reuse:** Config loader in `skill-config.ts` already parses YAML from `.github/planwerk.yml`; needs versioning + an edit-source check, not a new config system.

### A4. Ensemble Build mode ("Fork" action)
**Why:** Orchestra teams run 2–3 competing agents in parallel worktrees for ambiguous/high-risk work, then let a reviewer pick the winner. Planwerk's risk-proportional principle today only scales *gate intensity* (more scrutiny), never *exploration width* (more attempts).
**Idea:** Opt-in per card in Build: spin up N parallel sessions in isolated worktrees for the same task, auto-reviewer arbitrates or surfaces a side-by-side diff comparison before the card enters Review.
**Note:** Biggest lift of the six — needs multi-session-per-card data model changes (`KanbanCard` is currently 1:1 with an AHP session) and worktree orchestration. Worth prototyping only after A1–A3.

### A5. Stuck-loop reflection guardrail (refinement, not new)
**Why:** Research shows forced structured reflection before retry ("what failed / what would fix it / am I repeating myself") substantially cuts stuck-agent loops.
**Status:** Partially exists — `heartbeat.ts` already tracks `stuckSince`/`nudgeCount` and sends up to 3 nudges before escalating. The nudges are generic ("describe what's blocking you"), not a structured reflection protocol.
**Idea:** Upgrade `buildNudgeMessage()` to ask a specific reflection question referencing the failing gate/error, and log the reflection answer to the card's decision trail so a human can see *why* an agent got unstuck (or didn't).

### A6. Comprehension / cognitive-debt indicator
**Why:** Vision already claims "understanding didn't get cheap," but nothing today distinguishes a genuine review from a rubber-stamp approve. Research cites a 17% drop in code comprehension when engineers learn only through AI-generated code — the risk Planwerk's north star is implicitly promising to guard against.
**Idea:** Lightweight, non-blocking signal at Review/Ship — e.g., did the human expand the diff, leave a note, spend more than N seconds — surfaced as a soft nudge ("reviewed in 4s, no diff expanded") rather than a gate. Purely informational; never blocks.

---

## B. Existing vision ideas not yet built

Extracted by cross-checking [vision.md](./vision.md) / [architecture-and-design.md](./architecture-and-design.md) narrative against the current codebase (2026-07-07 audit).

### B1. True heterogeneous verification (model diversity)
Vision claims "a different reviewer — sometimes a different model" grades the work. `skill-config.ts` supports multiple named review skills and script gates, but there's no evidence any gate config actually assigns a *different model* per reviewer role (e.g., plan-review on one model, security-review on another). Worth deciding: is model diversity a config knob users set, or should Planwerk auto-diversify by default?

### B2. Dependency/blocker relationships between cards
Flagged in [review-backlog.md](./review-backlog.md) #6 as a data-model gap (`KanbanCard` has no `dependsOn`/`blockedBy`). Becomes more important once A1 (Coherence Gate) exists — coherence checks are much easier if the board already knows which cards are related.

### B3. Durable gate execution / job queue
`review-backlog.md` #5 — gates currently run via in-process `exec()`/timers. Fine for local dev, but blocks any future multi-agent ensemble mode (A4) which needs real concurrent job tracking, cancellation, and crash recovery.

### B4. Real WIP-aware prioritization suggestions
Vision's North Star describes the orchestrator "suggesting what to prioritize next" — WIP violations are detected (`heartbeat.ts` `wip-violation` action) but there's no suggestion/ranking logic yet, just a warning.

---

## How to use this file

When picking up new work, treat A1–A3 as the highest-leverage, lowest-lift items (they reuse existing plumbing: changeset tracking, audit log, YAML config loader). A4 is the most differentiated but also the biggest architectural lift — prototype only after the board-level coherence/governance primitives (A1, A3) exist, since ensembles make coherence problems worse before a Coherence Gate makes them visible.
