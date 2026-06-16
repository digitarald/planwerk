# Review Backlog — Unaddressed Findings

From rubber duck review (2026-06-15). Items to tackle in future iterations.

---

## 1. AHP Connection is Not Real

**Severity:** Blocking for real usage  
**Where:** `connection-store.ts`, `use-live-sessions.ts`, `/api/ahp/events`

The onboarding accepts `ws://...` but `connect()` only fakes a 1.5s delay. `useLiveSessions()` always reads from local `/api/ahp/events` which streams mock data regardless of `hostUrl`.

**To fix:**
- Store mode: `mock | remote`
- Validate host before marking connected
- Pass `hostUrl` to server routes or establish a real backend WebSocket proxy
- Make `/api/ahp/events` actually bridge from the selected host

---

## 2. Phase Transitions Not Persisted Server-Side

**Severity:** Architectural gap  
**Where:** `kanban-board.tsx`, `board-store.ts`, `gate-engine.ts`

DnD moves mutate client state only. The gate API reads phase from SQLite (defaults to "define"), which can disagree with the visible board. There's no reconciliation loop.

**To fix:**
- Replace direct `moveCard()` with async transition flow:
  1. Request transition intent → check gates → persist → update UI
- Hydrate card phases from SQLite on session load
- Support explicit manual override with audit metadata

---

## 3. Gate Results Become Stale Immediately

**Severity:** Correctness issue  
**Where:** `gate-engine.ts` — `canAdvancePhase()`

Accepts any previous passing gate run regardless of whether code changed since. No comparison against commit SHA, session revision, or diff hash.

**To fix:**
- Store validity key in `changeset_ref` (commit SHA / diff hash)
- Invalidate passing gates when AHP session changes after `completed_at`
- Show "stale" indicator in gate UI

---

## 4. SSE Updates Overwrite Local Metadata

**Severity:** Data loss on live updates  
**Where:** `use-live-sessions.ts`, `map-session.ts`

SSE updates replace most card fields via `mapSessionToCard()`, preserving only `phase`. This resets `gateStatus`, `risk`, `planSteps`, and any locally enriched fields.

**To fix:**
- Separate ownership: AHP owns runtime/activity/diff; Planwerk owns phase/gates/risk/review
- Use patch/merge semantics instead of full card replacement
- Only update AHP-owned fields on SSE events

---

## 5. Gate Execution Uses setTimeout (Not Durable)

**Severity:** Infrastructure gap  
**Where:** `/api/gates/run/route.ts`

Gate commands are "executed" via `setTimeout()` inside an API route handler. This is fine for demo but won't survive process restarts or handle real command execution.

**To fix:**
- Move gate execution to a durable local worker/process queue
- Subscribe UI to updates via SSE or polling
- Add timeout handling and cancellation

---

## 6. KanbanCard Type is Too Thin for Real Use

**Severity:** Data model gap  
**Where:** `lib/types.ts`

Missing fields needed for real SDLC:
- `provider`, `resource`, `project`, `repo`, `branch` (from AHP)
- PR/issue/session URLs
- Assignee/owner
- Priority
- `createdAt` / `updatedAt` separately
- Last gate failure summary
- Real file list (not hardcoded names in expansion)
- Dependency/blocker relationships between cards
- Unread/archived/read state from AHP `IsRead` / `IsArchived` bits

---

## 7. Mock Data Not Behaviorally Realistic

**Severity:** Testing gap  
**Where:** `/api/ahp/events/route.ts`, `mock-sessions.ts`

The mock SSE stream only changes `activity` and `additions`. It does not simulate:
- Phase progression over time
- Input-needed → recovery cycle
- Error → retry cycle
- Gate pass/fail transitions
- Session creation/removal events
- Stale session detection (idle too long)

Adding these would surface UX problems earlier and make demos more impressive.

---

## 8. Gate Tooltip Shows Raw Card IDs

**Severity:** Cosmetic  
**Where:** `components/gates/gate-pipeline.tsx`

Tooltips show content like "ahp-session:/session-1" instead of human-readable phase/gate descriptions. Need to map resource IDs to display names.

---

## 9. Card Badge Density

**Severity:** UX polish  
**Where:** `components/board/kanban-card.tsx`

"Needs input" and "Gate pending" as full-text badges consume too much space in 280px columns. Consider:
- Icon-only badges with tooltip
- Suppress "Gate pending" when ALL cards are pending (no signal)
- Colored dot + tooltip instead of text badge

---

## 10. Orchestrator Feed — System vs Chat Messages

**Severity:** UX clarity  
**Where:** `components/orchestrator/feed.tsx`

The "Connected. Monitoring 8 sessions" message is a system status, not a conversation turn. It should be visually distinct (pinned, different styling, or in the health bar area) to avoid mixing system announcements with user/CTO dialogue.
