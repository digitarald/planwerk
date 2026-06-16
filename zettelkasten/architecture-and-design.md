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
  phase: 'define' | 'plan' | 'build' | 'verify' | 'review' | 'ship';  // Persisted by Planwerk
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

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    Next.js App (App Router)                  │
├──────────────────┬─────────────────────────────────────────┤
│  Orchestrator    │  Board + Inline Card Expansion            │
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
| Framework | Next.js 15 (App Router) |
| UI | shadcn/ui + Tailwind CSS v4 |
| State | Zustand (client) with `useShallow` for derived selectors |
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
| **Build** | Agent writing code | Lint + typecheck pass → VERIFY |
| **Verify** | Deterministic checks (tests, build) | All green → REVIEW |
| **Review** | AI code review (qualitative) | Verdict: approved → SHIP |
| **Ship** | All gates passed, ready to merge | Archive ✓ |

---

## Feature Summary (MVP — Implemented)

| # | Feature | Description |
|---|---------|-------------|
| F1 | App Shell | Fixed desktop layout, title bar, sidebar + main |
| F2 | Kanban Board | 6 columns, DnD, WIP limits, compact cards |
| F3 | Card Expansion | Inline expand: gate pipeline, files, metadata, inject message |
| F4 | Orchestrator Feed | Conversational sidebar — read decisions + give commands |
| F5 | Real-Time Connection | SSE bridge, connection status, auto-reconnect |
| F6 | Project Config | `.github/planwerk.yml`, convention extraction |
| F7 | Gate Engine | GateRun records, SQLite persistence, stale detection |
| F8 | Notifications | Card pulses, column badges, title bar count, desktop notifs |
| F9 | Work Creation | + button, Cmd+K, orchestrator chat |
| F10 | AHP Connection | Onboarding, mock mode, saved connections |

---

## API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/ahp/events` | GET (SSE) | Stream session updates to browser |
| `/api/ahp/sessions` | GET | List current sessions |
| `/api/gates/run` | GET/POST | Check gate status, trigger/advance gates |
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
│       ├── ahp/{events,sessions}/
│       ├── gates/run/
│       └── orchestrator/{chat,review,status}/
├── components/
│   ├── app-shell.tsx
│   ├── title-bar.tsx
│   ├── command-palette.tsx
│   ├── live-session-provider.tsx
│   ├── notification-provider.tsx
│   ├── board/{kanban-board,kanban-column,kanban-card,card-expansion,session-creator,board-skeleton}.tsx
│   ├── orchestrator/{feed,feed-item,chat-input,health-bar}.tsx
│   ├── gates/gate-pipeline.tsx
│   ├── connection/{connection-dot,onboarding}.tsx
│   └── ui/ (shadcn)
├── lib/
│   ├── ahp/{types,mock-sessions,map-session}.ts
│   ├── orchestrator/{gate-engine,skills,risk-assessor}.ts
│   ├── store/{board-store,connection-store,orchestrator-store}.ts
│   ├── db/schema.ts
│   ├── hooks/{use-live-sessions,use-notifications}.ts
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
