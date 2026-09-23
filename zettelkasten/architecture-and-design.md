# Planwerk — Architecture & Design Document

> Revised 2026-06-15 after MVP implementation and dogfood review.

## What Is Planwerk?

A desktop-grade kanban board that gives developers a **hands-off agentic SDLC experience**. It connects to live AI agent sessions via Microsoft's Agent Host Protocol (AHP), organizes them as kanban cards across SDLC phases, enforces quality gates, and provides autonomous orchestration — so you can see all your work progressing without micromanaging each session.

**Core principle:** This is a *management surface*, not an IDE. No code in the UI. Show progress, state, decisions, and blockers.

---

## Key Design Decisions

### 1. Phase ≠ Runtime Status (Critical)

AHP runtime status (`Idle`, `InProgress`, `InputNeeded`, `Error`) does NOT drive column position. Planwerk persists the SDLC phase independently in SQLite. AHP events update card *facts*, and only the gate engine can transition phase.

**Why:** Without this separation, cards would jump unpredictably every time an agent goes idle or encounters an error. The user would lose trust in the board's stability.

```typescript
interface CardState {
  phase: 'define' | 'plan' | 'build' | 'review' | 'ship';  // Persisted by Planwerk
  runtime: 'idle' | 'running' | 'input-needed' | 'error';              // Live from AHP
  gateStatus: 'pending' | 'evaluating' | 'passed' | 'failed';          // Gate engine
  attention: 'none' | 'needs-human' | 'stale' | 'error' | 'conflict';  // Overlay
}
```

### 2. Coordinator Authority Is Explicit

The persistent coordinator has three server-enforced modes:

- `observe` (default): monitor facts, persist risk, and surface WIP, coherence, and blocker signals.
- `verify`: add configured commands, artifact checks, and report-only independent reviewer chats.
- `coordinate`: add primary-session interaction and autonomous gated phase advancement.

The board stores one default and optional host/session-scoped overrides in SQLite. The
effective mode is resolved for each card on every heartbeat tick, so a downgrade takes
effect without restarting the event stream. Already-running checks or reviewer turns may
finish and be recorded, but the new mode gates every downstream iteration, session write,
and phase mutation. Project config and risk policy remain additional constraints: a mode
can remove authority but never bypass or enable a disabled protection.

Mode governs unsolicited background work. Explicit human commands, pending-input answers,
and manual gated transitions remain available and keep their existing approval and audit
paths.

### 3. Orchestrator Is Conversational (Not Just a Feed)

The left sidebar is both a live decision log AND the primary input for managing the board. You read what the CTO is doing AND talk to it in the same surface. This eliminates context-switching between monitoring and control.

User can say: "Start a task for rate limiting", "Why is auth stuck?", "Override the review gate", "Pause all sessions".

### 4. Quality Gates Are First-Class Records

Gate results are `GateRun` records in SQLite — not derived from AHP tool-call history. This gives:
- Audit trail (who/what/when)
- Stale detection (code changed after review → gate invalidated)
- Independence from AHP session lifecycle

Tool-call history is a *hint* to avoid redundant runs, not proof of gate passage.

### 5. Skill-Based Reviews via Sub-Agents

Reviews are injected as skills that agents can invoke. Dual-invocation model:
1. **Agent-initiated** — Agent calls the review skill during its session (token-efficient)
2. **System-enforced** — If the agent finishes without invoking the required review, Planwerk triggers it externally before allowing phase advancement

Risk level determines gate intensity: low-risk tasks get lighter review, high-risk get adversarial plan review + security review + architecture review.

Risk verdicts are versioned against the server-owned facts snapshot
(`session_cache` plus persisted phase). A verdict is policy-authoritative only
when its non-null digest still matches those facts. Missing, legacy unbound, or
stale verdicts disable auto-answer and heartbeat automation; synchronous gate
and reviewer selection falls back to high-risk policy. Reassessment is explicit
and commits through a facts-snapshot compare-and-set, so an assessment can never
be attached to facts that changed while the model was running.

### 6. Convention-Based Config (Zero-Config Default)

Planwerk reads `.github/planwerk.yml` for explicit config, but also extracts from:
- `package.json` scripts (lint, test, typecheck, build)
- `.vscode/tasks.json` 
- `.github/github-app.yml`

Extracted commands are suggestions; user approves on first run.

### 7. Local Node.js App (Not Serverless)

Intentional architectural choice:
- `better-sqlite3` requires stable Node process
- AHP WebSocket connection is long-lived
- Orchestrator runs persistently (heartbeat loop)
- Gate commands execute locally in session worktrees

Think of it as a desktop app using Next.js for its UI layer.

### 8. DnD Is Gate-Aware (Not Free Movement)

Dragging a card forward logs a "manual override" to the orchestrator feed and marks the card with a warning. Moving backward is always allowed (rework). This preserves the gate enforcement model while still giving users escape hatches.

### 9. Coherence Is a Horizontal Gate (Board-Scoped)

Every other gate is **vertical** — a single card advancing its own pipeline, checked only against itself (`canAdvancePhase(cardId, …)`). The **Coherence Gate** is **horizontal**: a check *across* concurrent cards. When two in-flight cards (phase `build`/`review`) edit overlapping code, an external reviewer judges whether their changes cohere or clash.

**Why it can't be a normal gate:** the vertical gate abstraction is single-card by construction. Cross-card state lives in a board-scoped subsystem (`coherence-engine.ts`) that runs a detection pass in the heartbeat (like the WIP-violation pass) and *composes* with the vertical model only at the enforcement point.

Key mechanics that preserve existing invariants:

- **Detection is deterministic and cheap** (inverted-index overlap, tiered file/module, same-repo guarded). It never calls an LLM and never raises attention on its own.
- **Review is external and off-tick.** An async executor claims `detected` pairs (DB compare-and-set → `reviewing`) and runs a server-side Copilot-SDK reviewer over the *overlapping files' content* — never inline in the heartbeat tick, never the card's own agent. Verdict writes are race-guarded (`WHERE status='reviewing' AND signature=?`).
- **Phase ≠ runtime status still holds.** Coherence never moves a card between columns. It sets the (previously unused) `conflict` attention overlay for confirmed conflicts and, for high-risk pairs, blocks `review → ship`.
- **Risk-proportional, pair-level enforcement.** A conflict blocks ship only when *either* card in the pair is high-risk (both are then blocked, so a low-risk partner can't ship the conflicting change out from under it); low/medium conflicts are advisory. Blocking is computed live from current risk + config, not a stored flag, and high-risk pairs block *provisionally* during the detection→verdict window so a card can't slip to Ship before the reviewer answers.
- **Single choke point.** All `review → ship` advancement routes through `advanceReviewToShip()`; no path calls `setCardPhase(id,"ship")` directly for that transition.
- **Human override.** "Accept divergence" dismisses a pair for its current signature (audited); a materially different future overlap reopens it.

Config: `coherence.{enabled, module_depth, block_high_risk_ship}` in `planwerk.yml`. Persistence: `coherence_conflicts` table (signature-keyed, restart-recovers orphaned `reviewing` rows).

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    Next.js App (App Router)                  │
├──────────────────┬─────────────────────────────────────────┤
│  Coordinator     │  Inbox / Split / Board workspace         │
│  Drawer          │  + Card Detail Modal                     │
├──────────────────┴─────────────────────────────────────────┤
│  Client State (Zustand + SSE sync)                          │
├────────────────────────────────────────────────────────────┤
│  SSE Bridge (Route Handler: AHP WebSocket → EventSource)    │
├────────────────────────────────────────────────────────────┤
│  AHP TypeScript Client        SQLite (phases, gates, audit) │
│  Copilot SDK (orchestrator)   Skills (review sub-agents)    │
└────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router) |
| UI | shadcn/ui (on Base UI / `@base-ui/react`) + Tailwind CSS v4 |
| Markdown | `react-markdown` + `remark-gfm` (plan/review artifacts) |
| State | Zustand (client) with `useShallow` for derived selectors, workspace filter via `selectFilteredCards` |
| Real-time | Server-Sent Events bridging AHP WebSocket |
| AHP Client | `@microsoft/agent-host-protocol` TypeScript SDK |
| Orchestrator | `@github/copilot-sdk` (server-side, long-running) |
| Persistence | SQLite via better-sqlite3 |
| DnD | `@hello-pangea/dnd` |
| Icons | Lucide React |

---

## SDLC Columns

| Column | What Happens | Gate to Exit |
| --- | --- | --- |
| **Define** | Idea captured, being refined | Scope sufficiently clear → PLAN |
| **Plan** | Agent captures the intended outcome in `plan.md` | Adversarial intent review passes → BUILD |
| **Build** | Agent implements and corrects the change | Lint + typecheck + tests + build + independent correctness/architecture review pass → REVIEW |
| **Review** | System synthesizes final implementation and prior evidence against the original intent | Independent handoff assessment passes and readable sibling `review.md` captures validation, divergences, risks, and recommendation → SHIP |
| **Ship** | Review evidence is complete; ready for accountable human merge decision | Archive ✓ |

---

## Feature Summary (MVP — Implemented)

| # | Feature | Description |
|---|---------|-------------|
| F1 | App Shell | Fixed desktop layout with Inbox, Split, and Board workspace modes plus coordinator drawer |
| F2 | Kanban Board | 5 columns, DnD, WIP limits, compact cards |
| F3 | Card Detail | Modal detail view: gate pipeline, plan/review artifacts, files, metadata, inject message |
| F4 | Agent Inbox | Durable ranked handoffs with revision-bound, free-form Chief of Staff notes; context-specific primary and secondary actions; unread/open/snoozed/done lifecycle; and audit history |
| F5 | Orchestrator Feed | On-demand coordinator drawer — inspect activity and give commands |
| F6 | Real-Time Connection | SSE bridge, connection status, auto-reconnect |
| F7 | Project Config | `.github/planwerk.yml`, convention extraction |
| F8 | Gate Engine | GateRun records, SQLite persistence, stale detection |
| F9 | Notifications | Urgent inbox notifications, attention indicators, and title bar unread count |
| F10 | Work Creation | + button, Cmd+K, orchestrator chat |
| F11 | AHP Connection | Onboarding, local/remote host selection, saved connection, reconnect |
| F12 | Workspace Filter | Title bar filter shared by Inbox and Board; derived selector, stale-filter auto-reset |

---

## API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/ahp/events` | GET (SSE) | Stream session updates to browser; strict loopback/same-origin guard runs before AHP/heartbeat startup |
| `/api/ahp/sessions` | GET | List current sessions |
| `/api/ahp/sessions/message` | POST | Inject a message into a session |
| `/api/ahp/sessions/input` | POST | Respond to a session's input-needed prompt |
| `/api/gates/run` | GET/POST | Check gate status, trigger/advance gates |
| `/api/gates/status` | GET | Poll gate-run status for the client |
| `/api/orchestrator/chat` | POST | Handle user messages to CTO |
| `/api/orchestrator/chat` | DELETE | Explicitly delete the persisted CTO conversation |
| `/api/orchestrator/approvals` | GET/POST | Show non-authorizing approval metadata; decide with a one-time capability |
| `/api/orchestrator/mode` | GET/POST | Read or update the board default and per-session coordinator modes |
| `/api/orchestrator/status` | GET | Board health + orchestrator state |
| `/api/orchestrator/review` | GET/POST | Trigger/query skill-based reviews |

---

### CTO SDK continuity and authority

The CTO uses one restart-safe Copilot SDK conversation whose ID is stored in
SQLite. Every request acquires an expiring SQLite lease, resumes the conversation,
and re-registers its tools, hooks, event handlers, and permission policy. Release
atomically quarantines the binding before disconnect; a fully successful
disconnect restores the active binding without deleting history. Any reported
abort/disconnect failure or cleanup timeout leaves the binding quarantined before
lease release. Transport and timeout failures also retire that exact SDK runtime
generation. A later owner must reconcile bounded deletion before it can create a
replacement; it cannot resume the unconfirmed conversation.
If setup fails before a newly created conversation is durably bound, Planwerk
deletes that orphan (falling back to abort/disconnect and runtime invalidation);
a resumed conversation is never deleted by setup cleanup. Lease-renewal timer
failures are converted into normal cancellation/cleanup results rather than
escaping as process-level exceptions. Renewal remains active through async
disconnect and explicit deletion. SDK cleanup is time-bounded below the lease
TTL, and deletion clears the durable binding only with an atomic comparison of
the expected session ID and current lease owner. A late stale clearer therefore
cannot remove a replacement worker's binding.
Infinite-session compaction is bounded, and only privacy-filtered lifecycle,
correlation, model, and usage metadata is copied into the SDK event store.

Phase overrides fail closed without a persisted risk assessment. High-risk
overrides pause on an abortable, expiring human approval bound to the exact
normalized action, card/session identity, and current SQLite phase/risk facts;
the executor rechecks that binding in the same immediate transaction as the
mutation. Each approval is also bound to a unique process-boot owner whose
SQLite lease is renewed while its SDK waiter is live. Creation returns a
256-bit one-time decision capability only to the originating chat response;
SQLite stores a context-bound SHA-256 digest, never the raw value. Decision
comparison is constant-time and succeeds only while the same process owner and
in-memory SDK waiter remain live. Restart, owner loss, waiter cancellation,
expiry, or replay fails closed. The general GET endpoint has display metadata
but no approval ID, digest, or capability. Decision POSTs require an exact
loopback Origin/Host match and JSON content type; the server records the stable
`local-human` actor and rejects client actor fields. Tool calls use owner leases:
schema initialization never rewrites a running lease, completed results survive
restarts, retryable failures are released, and only lease expiry allows
recovery. Expired ambiguous mutations become explicit needs-human outcomes
unless authoritative state proves completion. Runtime
reassessment versions server-owned session-cache summary/enrichment and current
phase facts with a stable digest. It commits `card_risk` by compare-and-swap
only while that digest remains current; missing legacy digests fail closed.
Consumed approvals retain the process-owner lease requirement through the
owner-fenced phase transaction, so permission consumption cannot survive a
restart. Approval turns use a bounded timeout covering the approval TTL plus
execution overhead, and stream termination expires both waiter and UI item.
Tool-execution schema upgrades rebuild and merge active/stranded legacy history
inside an IMMEDIATE transaction, preserving completed and ambiguous outcomes.
transport failures retire one SDK generation only after its active operations
drain, while domain and parsing failures remain session-local. Conversation
memory is advisory: live AHP facts and SQLite phase/gate/approval state remain
authoritative.

Durable CTO session bindings have explicit `active` and `deleting` states.
Disconnect and deletion first write an owner-fenced tombstone. Confirmed
disconnect restores `active`; every unconfirmed outcome retains quarantine, and
runtime-invalidating failures retire the client generation. Restart
reconciliation must confirm deletion before creating a replacement, while
restoration and final cleanup CAS session ID, deletion token, and lease owner.
AHP client shutdown is post-result cleanup: failures are logged without replacing
already-confirmed session, chat, or turn identities.

The capability narrows the local trust boundary; it does not add user
authentication. See [Security model](security.md) for assumptions and limits.

Peer-chat disposal is durable in `review_chat_cleanups`, keyed by normalized
originating AHP host plus immutable chat URI and independent of the mutable
review-iteration row. Setup and dispatch
failures record cleanup identity and the first failed disposal atomically with
review failure state. A lost `createChat` acknowledgement is treated as possibly
applied and disposed by its preselected URI before retry. The process-wide
heartbeat scans retryable rows across every stored origin host and dispatches
each disposal through that row's host, so a host does not need an active board
stream for its cleanups to progress.
If a confirmed dispatch loses its review owner before the turn identity commits,
the queue durably retains the host, chat, turn, and diagnostic without allowing
the stale owner to rewrite replacement state. Replacement dispatch is fenced
until peer-chat disposal succeeds; default-chat identities are quarantined for
human resolution because disposing the session's primary chat is unsafe.
Legacy rows without a recoverable origin are quarantined rather than sent to an
arbitrary current host. Workers use persisted unique owners and renewable
leases; owner-fenced compare-and-swap completion prevents stale workers from
completing replacement claims, and schema initialization recovers only claims
whose leases expired.
The heartbeat performs at most three total disposal attempts; later review
iterations cannot erase earlier cleanup diagnostics or rewrite terminal
verdicts.

---

## File Structure

```
planwerk/
├── app/
│   ├── layout.tsx
│   ├── page.tsx
│   └── api/
│       ├── ahp/{events,sessions,sessions/message,sessions/input}/
│       ├── gates/{run,status}/
│       └── orchestrator/{chat,mode,review,status}/
├── components/
│   ├── app-shell.tsx
│   ├── title-bar.tsx
│   ├── command-palette.tsx
│   ├── live-session-provider.tsx
│   ├── notification-provider.tsx
│   ├── board/{kanban-board,kanban-column,kanban-card,card-detail-modal,artifact-viewer,pending-input-card,session-creator,board-skeleton}.tsx
│   ├── orchestrator/{feed,feed-item,chat-input,health-bar}.tsx
│   ├── gates/gate-pipeline.tsx
│   ├── connection/{connection-dot,onboarding}.tsx
│   └── ui/ (shadcn on Base UI)
├── lib/
│   ├── ahp/{types,protocol,map-session,enrich-card,changeset-enricher,client-bridge,client-operation,session-messenger,actions,connection-error,plan-artifact,telemetry-logs,telemetry-transport}.ts
│   ├── orchestrator/{orchestrator-agent,heartbeat,coordinator-mode,coordinator-mode-store,gate-engine,skills,skill-config,risk-assessor,risk-store,review-executor,verdict-extractor,triage,auto-answerer,board-context,tool-executor}.ts
│   ├── store/{board-store,connection-store,orchestrator-store}.ts
│   ├── db/{schema,session-cache}.ts
│   ├── hooks/{use-live-sessions,use-notifications,use-persistent-state}.ts
│   └── types.ts
├── .github/planwerk.yml
└── zettelkasten/
```

---

## Lessons Learned During Implementation

1. **Zustand selectors with `.filter()` cause infinite re-render loops** — Must use `useShallow` from `zustand/react/shallow` for any selector that returns a new array/object reference.

2. **SSE is the right choice over WebSocket for the browser side** — Next.js route handlers can stream SSE natively. The backend holds the real WebSocket to AHP. This avoids client-side WebSocket complexity and works with any hosting.

3. **Mock data must distribute across phases** — Having all sessions in "define" makes the board look broken. Mock data needs to be behaviorally realistic to catch UX issues early.

4. **Redundant headings waste precious vertical space** — Desktop-grade apps communicate via their structure, not explanatory text. The title bar + column headers ARE the information architecture.

5. **Chat ordering matters** — Activity feeds are newest-first; conversations are chronological. When mixing both in one surface, use `flex-col-reverse` with newest-first data to get natural bottom-anchored scrolling.

6. **Gate enforcement on DnD is a UX balance** — Blocking moves entirely feels hostile. Allowing with a warning (+ audit log) gives users control while maintaining the enforcement model's integrity.
