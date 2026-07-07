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

### 2. Orchestrator Is Conversational (Not Just a Feed)

The left sidebar is both a live decision log AND the primary input for managing the board. You read what the CTO is doing AND talk to it in the same surface. This eliminates context-switching between monitoring and control.

User can say: "Start a task for rate limiting", "Why is auth stuck?", "Override the review gate", "Pause all sessions".

### 3. Quality Gates Are First-Class Records

Gate results are `GateRun` records in SQLite — not derived from AHP tool-call history. This gives:
- Audit trail (who/what/when)
- Stale detection (code changed after review → gate invalidated)
- Independence from AHP session lifecycle

Tool-call history is a *hint* to avoid redundant runs, not proof of gate passage.

### 4. Skill-Based Reviews via Sub-Agents

Reviews are injected as skills that agents can invoke. Dual-invocation model:
1. **Agent-initiated** — Agent calls the review skill during its session (token-efficient)
2. **System-enforced** — If the agent finishes without invoking the required review, Planwerk triggers it externally before allowing phase advancement

Risk level determines gate intensity: low-risk tasks get lighter review, high-risk get adversarial plan review + security review + architecture review.

### 5. Convention-Based Config (Zero-Config Default)

Planwerk reads `.github/planwerk.yml` for explicit config, but also extracts from:
- `package.json` scripts (lint, test, typecheck, build)
- `.vscode/tasks.json` 
- `.github/github-app.yml`

Extracted commands are suggestions; user approves on first run.

### 6. Local Node.js App (Not Serverless)

Intentional architectural choice:
- `better-sqlite3` requires stable Node process
- AHP WebSocket connection is long-lived
- Orchestrator runs persistently (heartbeat loop)
- Gate commands execute locally in session worktrees

Think of it as a desktop app using Next.js for its UI layer.

### 7. DnD Is Gate-Aware (Not Free Movement)

Dragging a card forward logs a "manual override" to the orchestrator feed and marks the card with a warning. Moving backward is always allowed (rework). This preserves the gate enforcement model while still giving users escape hatches.

### 8. Coherence Is a Horizontal Gate (Board-Scoped)

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
│  Orchestrator    │  Board + Card Detail Modal                │
│  Live Feed       │  (single view, no routing)               │
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
| **Plan** | Agent produces spec/plan | Adversarial review passes → BUILD |
| **Build** | Agent writing code | Lint + typecheck + tests pass → REVIEW |
| **Review** | AI code review + human review (qualitative) | Verdict: approved → SHIP |
| **Ship** | All gates passed, ready to merge | Archive ✓ |

---

## Feature Summary (MVP — Implemented)

| # | Feature | Description |
|---|---------|-------------|
| F1 | App Shell | Fixed desktop layout, title bar, sidebar + main |
| F2 | Kanban Board | 5 columns, DnD, WIP limits, compact cards |
| F3 | Card Detail | Modal detail view: gate pipeline, plan/review artifacts, files, metadata, inject message |
| F4 | Orchestrator Feed | Conversational sidebar — read decisions + give commands |
| F5 | Real-Time Connection | SSE bridge, connection status, auto-reconnect |
| F6 | Project Config | `.github/planwerk.yml`, convention extraction |
| F7 | Gate Engine | GateRun records, SQLite persistence, stale detection |
| F8 | Notifications | Card pulses, column badges, title bar count, desktop notifs |
| F9 | Work Creation | + button, Cmd+K, orchestrator chat |
| F10 | AHP Connection | Onboarding, local/remote host selection, saved connection, reconnect |
| F11 | Workspace Filter | Dropdown in TitleBar to filter board by AHP project; derived selector, stale-filter auto-reset |

---

## API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/ahp/events` | GET (SSE) | Stream session updates to browser |
| `/api/ahp/sessions` | GET | List current sessions |
| `/api/ahp/sessions/message` | POST | Inject a message into a session |
| `/api/ahp/sessions/input` | POST | Respond to a session's input-needed prompt |
| `/api/gates/run` | GET/POST | Check gate status, trigger/advance gates |
| `/api/gates/status` | GET | Poll gate-run status for the client |
| `/api/orchestrator/chat` | POST | Handle user messages to CTO |
| `/api/orchestrator/status` | GET | Board health + orchestrator state |
| `/api/orchestrator/review` | GET/POST | Trigger/query skill-based reviews |

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
│       └── orchestrator/{chat,review,status}/
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
│   ├── ahp/{types,protocol,map-session,enrich-card,changeset-enricher,client-bridge,client-manager,session-messenger,actions,connection-error,plan-artifact,telemetry-logs,telemetry-transport}.ts
│   ├── orchestrator/{orchestrator-agent,heartbeat,gate-engine,skills,skill-config,risk-assessor,risk-store,review-executor,verdict-extractor,triage,auto-answerer,board-context,tool-executor}.ts
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
