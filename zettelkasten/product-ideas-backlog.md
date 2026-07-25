# Product Ideas Backlog — For Later Inspiration

> Not a sprint plan. A parking lot for product ideas worth revisiting — some sparked by external research, some already implied by [vision.md](./vision.md) / [architecture-and-design.md](./architecture-and-design.md) but never turned into a feature. See [review-backlog.md](./review-backlog.md) for implementation bugs/gaps instead — this file is about *what to build next*, not *what's broken*.

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

## B. New ideas from AI-native code review research

Context: AgentField's [AI-Native Code Review](https://agentfield.ai/blog/ai-native-code-review) argues that AI-written changes break apart four jobs that traditional pull-request review bundled together:

1. **Correctness** — does the change do what it claims?
2. **Knowledge transfer** — does another person understand the change?
3. **Risk visibility** — can the team see what the change introduces?
4. **Distributed accountability** — does another accountable human stand behind the decision?

Those jobs traveled together because human writing and review were slow enough for one synchronous ritual to perform all four. Agent-written code changes the economics unevenly: checking becomes cheap and parallel, knowledge transfer becomes one-way, change volume outgrows human reading capacity, and accountability remains human. The article's strongest transferable idea is therefore to treat review as a **risk telescope**, not a certificate of correctness: independent agents discover risks across change-specific dimensions, deterministic policy applies visible thresholds, and humans decide what deserves attention.

Planwerk should adopt the reframe, but not the article's strongest rhetoric wholesale. "The same kind of intelligence can check the code while writing it" does not make independent review redundant; it makes **independence, evidence, and diversity** more important. A reviewer with the same model, context, incentives, and blind spots can produce a confident echo rather than verification. Planwerk's differentiated position should be:

> Deterministic tools establish the correctness properties they can prove. Independent AI reviewers map uncertainty they cannot prove away. The gate engine applies policy. A human remains accountable for exceptional and high-stakes decisions.

This preserves Planwerk's core invariants: phase is not runtime status, the author never grades its own work, only the gate engine advances phase, and every autonomous decision remains inspectable and overridable.

### B0. Product thesis: Review is an attention-allocation system
**Why:** When agents produce changes faster than humans can read them, the scarce resource is no longer implementation effort; it is informed human judgment. A queue of green checks does not help allocate that resource, and a feed of everything agents did actively obscures it.
**Idea:** Recast Review as the place where Planwerk answers, "What deserves attention, why, and what decision is needed?" The primary artifact is not a reviewer transcript or universal confidence score. It is a prioritized map of uncertainty with evidence, freshness, and explicit decision boundaries.

This also separates the two interaction gulfs:
- **Execution:** agents run tests, gather context, launch reviewers, challenge findings, and retry fixes with minimal human operation.
- **Evaluation:** humans inspect material risks, compare alternatives, understand provenance, steer interpretation, accept debt, reopen design, or override policy.

The Review UI should spend its design budget on the second gulf. Chat remains the steering hand; the persistent Risk Map becomes the judgment canvas.

### B1. Review Risk Map (replace the binary AI verdict)
**Why:** A single pass/fail result hides uncertainty, evidence, and which parts of a change deserve scrutiny. It also invites users to treat an AI verdict as proof of correctness.
**Idea:** Preserve tests, type checks, lint, and scanners as deterministic gates. Have AI review produce a persisted, dimension-grouped map instead. Candidate dimensions include:

- Security and privacy
- Data integrity and migration safety
- API and contract compatibility
- Test adequacy and test realism
- Performance and resource behavior
- Failure recovery, concurrency, and idempotency
- Architecture and dependency direction
- Cross-card coherence
- AI-generated-code failure patterns
- Repository-specific invariants

Each dimension shows:
- Current state: clear, advisory, blocking, needs-human, stale, accepted, or superseded
- Findings ranked by deterministic severity/priority policy
- Evidence and the claim that evidence supports
- What context and checks were examined
- Threshold and why the finding did or did not cross it
- Reviewer/provider/model provenance
- Exact plan, diff, commit, or coherence signature reviewed
- Delta from the previous review iteration

The gate engine — never the reviewer — computes whether the aggregate map blocks Ship. Avoid one combined "risk score": aggregation hides whether a low-probability security issue was averaged away by five clear dimensions.

### B2. Dynamic Review Plan
**Why:** Fixed review checklists spend equal attention on unequal changes. A dependency bump, schema migration, and authentication rewrite expose different risks.
**Idea:** Before Review, generate a structured plan selecting dimensions, reviewer roles, target/context files, evidence requirements, depth, model policy, threshold, and budget from the card's declared intent, risk, and change topology.

Examples:
- A copy-only UI change may need deterministic checks plus accessibility and product-intent dimensions.
- A schema migration should add rollback, compatibility-window, data-integrity, and deployment-order dimensions.
- Authentication work should trigger security-specialist review, adversarial misuse cases, explicit human sign-off, and a stricter evidence threshold.
- Two cards touching an interface should trigger cross-card contract and integration dimensions even if either diff looks locally safe.

Low-risk cards get a small panel and nearly invisible execution. High-risk cards get deeper, parallel, and adversarial passes. Use cheap constrained classification for routing and reserve expensive autonomous agent loops for selected dimensions. Persist the generated plan so humans can challenge not only a finding, but also what the system chose not to inspect.

### B3. Review Artifact and deliberation record
**Why:** Accountability requires more than the final decision. Humans need to know what was reviewed, against which code, by whom, using what evidence, and why a threshold or override applied.
**Idea:** Persist every review as a durable artifact tied to an exact plan/diff/commit reference. Borrow the shape of a provenance attestation:

- **Subject:** card, repository, base/head commits, plan hash, diff hash
- **Builder:** author session and model identity
- **Review plan:** selected dimensions, thresholds, budgets, prompt/tool configuration hashes
- **Execution:** reviewer identities, providers, model versions, start/end times, cost
- **Evidence:** file/line references, snippet hashes, tests, logs, callers/importers consulted
- **Findings:** structured claim, severity, confidence, falsification attempts, disposition
- **Decision:** deterministic policy result and gates affected
- **Deliberation:** what a human considered, how factors were weighed, and why an exception or acceptance won

Automatically mark affected dimensions stale when their subject changes. Freshness is a state, not decorative metadata: a previously green finding must never continue to look verified after relevant inputs change. Human acceptance, dispute, debt, and gate overrides require a reason and remain visible rather than deleting the finding. The audit trail should answer "who authorized this outcome?" as readily as "which agent ran?"

### B4. Typed finding destinations
**Why:** Not every risk belongs at the merge gate. An architectural objection discovered during Review usually means an upstream design decision needs reopening.
**Idea:** Route findings to explicit destinations:

- **Block Ship:** policy forbids advancement until resolved.
- **Return to Build:** implementation is wrong but intent/design remains valid.
- **Reopen Plan:** interface, architecture, or acceptance criteria need reconsideration.
- **Advisory:** record and ship; useful for future work or trend analysis.
- **Accept as debt:** create a typed, owned, time-bounded debt item.
- **Needs human:** evidence is ambiguous or consequences exceed delegated authority.
- **Dispute/re-review:** human supplies missing context and asks an independent reviewer to reassess.

Keep "accept this risk" distinct from "override the gate." The first says the finding is valid and tolerable; the second says policy is being bypassed. Also distinguish a human disagreement with the finding from acceptance of a known risk. These are different accountability claims and should remain visible as such.

### B5. External, heterogeneous reviewer pool
**Why:** A separate prompt in the authoring session is not independent verification, and same-family builder/reviewer pairs may share blind spots.
**Idea:** Run reviewers in separate read-only sessions or worktrees. Support per-role model policies:

- Cheap/fast model for risk routing
- Strong code model for implementation review
- Specialist model or deterministic tool for security
- Different provider/family for adversarial challenge
- Deterministic code for threshold scoring and final gate aggregation

For high-risk work, require diversity rather than merely parallelism. Ten identical reviewers are not ten independent judgments. Add a falsification layer that tries to invalidate each proposed finding by looking for intended behavior, existing mitigations, safe callers, tests, or weak evidence before the finding reaches a human.

Treat issue text, code comments, generated docs, dependency metadata, and logs as untrusted evidence, never reviewer instructions. The review harness must make the authority boundary explicit so repository prompt injection cannot turn a malicious comment into a green gate.

### B6. Cross-card risk telescope
**Why:** The most consequential failure may not exist in either card's diff: individually valid changes can violate a shared contract or converge on incompatible architecture.
**Idea:** Extend the implemented Coherence Gate into a review dimension that considers concurrent cards, declared dependencies, interface assumptions, and system-level evidence.

This should detect cases such as:
- One card mocks an API another card never exports
- Producer and consumer agree syntactically but disagree semantically
- A schema and cache change merge cleanly but violate invalidation rules
- Parallel agents introduce competing abstractions for the same capability
- Tests pass in isolated worktrees but deployment ordering makes the combined release unsafe

Reviewers need a precomputed dependency/change graph rather than one enormous context dump; long-context availability is not the same as reliable attention. Surface compound risks on every affected card and preserve one board-level resolution record so two card views cannot disagree about the same conflict.

### B7. Risk-proportional judgment surface
**Why:** As agents increase change volume, human attention — not code generation — becomes the scarce resource. The UI should help people judge outcomes, not replay agent activity.
**Idea:** Evolve Review detail into an inspectable Risk Map:

- **Board card:** only the few dimensions requiring attention, stale markers, and the decision currently needed.
- **Review detail:** dimension-grouped findings, visible thresholds, evidence, provenance, rationale, and last-verified subject.
- **Risk delta:** before/after comparison across fix-and-review iterations.
- **Compare:** dimension-aligned views for coherence peers or competing Ensemble Build attempts.
- **Steer:** attach human context to a specific dimension and rerun the relevant reviewer.
- **Correct:** dispute a finding without erasing it.
- **Override:** accept risk or advance against policy with mandatory justification.

UI density should scale with stakes. Low-risk cards collapse to "dimensions checked; all current." Medium/high-risk cards expose the map automatically. High-risk Ship handoff should require explicit acknowledgment of material dimensions, but interaction telemetry must not pretend to prove comprehension: spending 30 seconds or expanding a row is at most a cognitive-debt signal, never evidence that the human understood the change.

Accessibility is part of the judgment model: every state and threshold must be narratable, keyboard-operable, and distinguishable without color. A screen-reader user must be able to inspect evidence, steer review, accept risk, and sign off without losing provenance or sequence.

### B8. Shadow-mode validation before enforcement
**Why:** AI review can create alert fatigue, correlated blind spots, prompt-injection exposure, cost spikes, and misleading confidence. "Findings produced" rewards noise rather than safety.
**Idea:** Introduce the Risk Map as a non-blocking shadow artifact first. Measure outcomes rather than reviewer activity:

- Confirmed high-severity risks humans/tests would otherwise have missed
- False-positive and disputed-finding rates by dimension
- Precision at the blocking threshold
- Time from named risk to accepted fix
- Human engagement with material findings
- Review latency and cost per change/risk class
- Staleness and re-review frequency
- Escape rate for seeded and production defects

Do not optimize for findings produced, comments posted, or aggregate risk score; those invite Goodhart behavior and alert fatigue.

Run explicit experiments:

1. **Maker/checker heterogeneity:** seed subtle defects and compare same-family review, different-family review, and different-family plus deterministic analysis.
2. **Evasion and prompt injection:** place persuasive instructions in issue text, comments, generated docs, and fixtures; verify reviewers treat them as data.
3. **Coherence stress:** create changes that merge and test independently but violate a shared runtime contract.
4. **Shadow usability:** determine whether humans voluntarily inspect and act on the map before adding blocking friction.
5. **Threshold calibration:** replay known changes to learn per-dimension bars without changing historical outcomes.

Candidate kill criteria include a majority of blocking findings being false, critical seeded defects routinely escaping, review latency exceeding the team's useful decision window, or cost growing faster than confirmed risk discovery. Promote individual dimensions to blocking only after they demonstrate useful precision; deterministic checks remain dominant throughout.

### B9. Trust boundaries and failure modes
These ideas should be evaluated against their characteristic failure modes:

- **Correlated blind spots:** model diversity reduces shared errors but does not prove independence.
- **Automation bias:** a polished map can make humans less likely to inspect underlying evidence.
- **Goodhart pressure:** builders may optimize for reviewer heuristics rather than system quality.
- **False completeness:** a list of checked dimensions can imply unexamined dimensions are safe.
- **Long-context theater:** retrieving the whole repository does not mean the reviewer reasoned over it reliably.
- **Stale-as-fresh:** any mismatch between verdict subject and current code is a severity-one trust bug.
- **Threshold laundering:** configurable policy can become a way to normalize risk until the board turns green.
- **Accountability theater:** requiring a click or human name without real authority to steer is not oversight.

Mitigations should be structural: evidence links, explicit coverage claims and omissions, deterministic scoring, independent sessions, append-only deliberation, freshness invalidation, reversible overrides, and periodic seeded evaluations.

**Suggested sequence:** Review Artifact + static dimensions → shadow Risk Map → external reviewer sessions → dynamic planning and falsification → selective blocking → cross-card synthesis. Do not begin with a large UI rebuild or a universal AI pass/fail gate.

**North-star statement:** Planwerk Review becomes an evidence-backed, freshness-aware map of uncertainty. Ship remains a deterministic policy decision with explicit human accountability.

---

## C. Existing vision ideas not yet built

Extracted by cross-checking [vision.md](./vision.md) / [architecture-and-design.md](./architecture-and-design.md) narrative against the current codebase (2026-07-07 audit).

### C1. True heterogeneous verification (model diversity)
Vision claims "a different reviewer — sometimes a different model" grades the work. `skill-config.ts` supports multiple named review skills and script gates, but there's no evidence any gate config actually assigns a *different model* per reviewer role (e.g., plan-review on one model, security-review on another). Worth deciding: is model diversity a config knob users set, or should Planwerk auto-diversify by default?

### C2. Dependency/blocker relationships between cards
Flagged in [review-backlog.md](./review-backlog.md) #6 as a data-model gap (`KanbanCard` has no `dependsOn`/`blockedBy`). Becomes more important once A1 (Coherence Gate) exists — coherence checks are much easier if the board already knows which cards are related.

### C3. Durable gate execution / job queue
`review-backlog.md` #5 — gates currently run via in-process `exec()`/timers. Fine for local dev, but blocks any future multi-agent ensemble mode (A4) which needs real concurrent job tracking, cancellation, and crash recovery.

### C4. Real WIP-aware prioritization suggestions
Vision's North Star describes the orchestrator "suggesting what to prioritize next" — WIP violations are detected (`heartbeat.ts` `wip-violation` action) but there's no suggestion/ranking logic yet, just a warning.

---

## How to use this file

When picking up new work, treat A1–A3 as the highest-leverage, lowest-lift Factory vs. Orchestra items (they reuse existing plumbing: changeset tracking, audit log, YAML config loader). For AI-native review, start with B3 and a static, non-blocking slice of B1; trustworthy artifacts and measured shadow results should precede dynamic reviewer fleets or blocking policy. A4 remains the most differentiated but also the biggest architectural lift — prototype only after the board-level coherence/governance primitives (A1, A3) exist, since ensembles make coherence problems worse before a Coherence Gate makes them visible.
