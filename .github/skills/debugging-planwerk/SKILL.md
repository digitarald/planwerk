---
name: debugging-planwerk
description: "High-level map of Planwerk's diagnostic sources — where the truth lives when a card shows the wrong phase, status, gate, pending input, or enrichment. Use when investigating why a card looks wrong on the board, why the orchestrator/heartbeat did or didn't act, why a session's facts (files, plan, input) are missing or stale, or any 'why is this card doing X' question. Covers the SQLite store, the live AHP host, per-session Copilot CLI files, server logs, telemetry, and static checks — not any one specific bug."
---

# Debugging Planwerk

Planwerk renders AI agent sessions as kanban cards. A card's on-screen state is
**derived** from several layered sources, so "the card looks wrong" is almost always a
question of *which layer disagrees with which*. This skill is a map of those sources and
how to read them. It does **not** prescribe fixes — it tells you where to look first.

> **⚠️ Keep this skill current.** This is living documentation of Planwerk's debugging
> flow. Whenever you change *where* diagnostic truth lives or *how* to read it — a new/
> moved data source, a renamed log prefix or env flag, a changed DB path/table or telemetry
> format, a new debug command or subsystem, an altered data-flow path, or an invalidated
> caveat — **update this SKILL.md in the same change.** If a debugging session reveals a
> source or step that was missing or wrong here, fix it here too. A stale map sends the
> next investigator down the wrong path.

## Orient: the data flow

```
Live AHP host (WebSocket, copilotcli provider)
        │  SessionSummary / SessionState / ChatState / ChangesetState
        ▼
lib/ahp/client-bridge.ts   ── subscribes, enriches, fetches pending input
        │  BridgeEvent (+ enrichment, +/- pendingInput)
        ▼
app/api/ahp/events/route.ts (SSE)  ── maps session → KanbanCard, runs triage
        │  CardStreamEvent
        ▼
lib/store/board-store.ts (Zustand)  ── client card state
        │
        ▼
components/board/*  ── what you see

lib/orchestrator/heartbeat.ts  ── separate loop; reads workspace-scoped cards, runs
                                   gates/reviews, advances phase, answers input
                                   (writes to SQLite)
```

Two invariants worth re-checking before deep debugging (see `AGENTS.md`):
- **Phase ≠ runtime status.** SDLC phase is persisted by Planwerk (SQLite). AHP runtime
  status (`idle`/`running`/`input-needed`/`error`) only updates card *facts*.
- **Only the gate engine advances phase forward.** Runtime status never moves a card
  between columns.

## The sources (where the truth lives)

### 1. SQLite persistence DB — Planwerk's own state
`.planwerk/planwerk.db` (better-sqlite3; schema in `lib/db/schema.ts`). This is where
persisted phase, gates, risk, and orchestrator decisions live. **Read-only inspect** it
out-of-band; the running app holds a write connection.

Tables: `card_phases`, `card_risk`, `card_status_history`, `coherence_conflicts`,
`gate_configs`, `gate_runs`, `heartbeat_log`, `review_runs`, `session_cache`.

```bash
node -e '
const db = require("better-sqlite3")(".planwerk/planwerk.db", { readonly: true });
for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all("table")) console.log(r.name);
'
```
Good first queries: `card_phases` (persisted column), `heartbeat_log`
(what the orchestrator did/decided, newest `id` first), `gate_runs` / `review_runs`
(gate outcomes + staleness), `card_risk` (triage verdict driving gate intensity).

### 2. Session cache — the facts a card was derived from
The `session_cache` table (`session_uri, host_url, summary_json, enrichment_json,
updated_at`) stores the last AHP `SessionSummary` and enrichment per session. This is the
fastest way to see **what inputs `mapSessionToCard`/`inferPhase` actually saw** (status,
`changes`, `activity`, `annotations`, `codeFileCount`, artifacts, and informational
`changesetReview`) without a live host. `changesetReview` contains the static session
changeset URI, opaque file IDs, and host-owned reviewed bits; it does **not** affect gates,
risk, or phase. Tool authentication is likewise represented only as a redacted
`pendingInput` handoff — it never contains OAuth challenge data.
Note `enrichment_json` may be `null` — enrichment is best-effort and async.

### 3. Live AHP host — the source of truth for runtime facts
The cache and DB can lag; the WebSocket host is authoritative. Find the port and connect
with the SDK (mirror `scripts/ahp-smoke.ts`).

```bash
# WebSocket hosts answer HTTP with 426 Upgrade Required
lsof -nP -iTCP -sTCP:LISTEN | grep -i node   # find candidate ports
curl -s -i http://127.0.0.1:PORT/ | head -1  # expect: 426 Upgrade Required
```
The built-in smoke harness connects, lists sessions, and reads one session's
`SessionState` (inputNeeded) + `ChatState` (turns):
```bash
AHP_SMOKE_HOST=ws://127.0.0.1:PORT npm run ahp:smoke
```
For the real catalog owned by the running VS Code desktop process, use Planwerk's
logical local endpoint:
```bash
AHP_SMOKE_HOST=vscode-local://desktop npm run ahp:smoke
```
It discovers `vscode-agent-host-*.sock` only in the current user's temporary directory,
tests each candidate through an AHP handshake, and chooses the compatible host with the
largest full paginated catalog (then newest socket, then path). The logical endpoint is
stable even when VS Code rotates the socket; its cache key is intentionally not the
ephemeral filesystem path.

The standalone TCP server is still useful for an explicit, isolated host:
```bash
code agent host --host 127.0.0.1 --port 8082 --without-connection-token
```
It creates a distinct Agent Host and can therefore have a separate, empty session
catalogue. Do **not** use it as evidence that the desktop catalog is empty.

When the board is empty, distinguish these diagnostic states before changing code:
- `vscode-local://desktop` reports no socket: VS Code has not exposed its on-demand
  Agent Host socket. Enable **Chat: Agent Host** and retry; Planwerk intentionally does
  not fall back to port 8082.
- The selected host has `totalSessions: 0`: the host catalog itself is empty.
- `totalSessions > 0` with `visibleSessions: 0`: every catalog entry was filtered
  because it is archived without code changes. This is an intentional board filter.
- Multiple compatible socket candidates: diagnostics record the chosen catalog size and
  selection rule. A host with more sessions wins, so an empty standalone instance cannot
  hide an active desktop catalog.
- No compatible socket candidates: Planwerk preserves structured handshake evidence. When
  every candidate proves a protocol mismatch and exact versions make the direction
  provable, the connection error says whether every host is older or newer than Planwerk;
  mixed exact versions are reported as no tested overlap. If any candidate instead fails
  for transport/auth reasons, Planwerk keeps the generic connection failure rather than
  overstating the version evidence.
  SemVer ranges, malformed values, or missing version data stay explicitly indeterminate.
  Planwerk never retries by advertising a host version it has not tested.
For a specific session, subscribe to its `resource` and inspect `snapshot.state`:
`inputNeeded` (pending input / approvals / OAuth handoffs), `changesets` (file changes),
`defaultChat`, `status`, `lifecycle`. For changeset-review state, subscribe to the selected
static session changeset and inspect its `ChangesetState.files[].reviewed`; its catalogue
`capabilities.review` is presence-based (an empty object is supported). Use
`lib/ahp/snapshot.ts` helpers (`readSessionState`, `readChatState`,
`readChangesetState`) to narrow the snapshot union. Standalone SDK scripts run under
`node --experimental-strip-types` and can import `../lib/ahp/*.ts` **relatively** (the
`@/` alias does not resolve outside Next/tsc).

VS Code's **All Changes** entry is the static catalogue item whose
`changeKind === "session"`. Its subscribed snapshot can initially be
`status:"computing"`; a client must briefly reduce the subsequent `changeset/*` actions
into that snapshot until `changeset/statusChanged` reports `ready`, or keep the result
unknown and retry. Do **not** re-subscribe to get a fresh snapshot after readiness:
current VS Code starts another computation for each subscription. Closing immediately
on the computing snapshot can leave `changesetVerified:false` even though VS Code later
renders the completed All Changes view.

### 4. Copilot CLI per-session files — what the agent actually did
`~/.copilot/session-state/<session-uuid>/` (the UUID is the tail of a `copilotcli:/<uuid>`
card id). Contents worth reading:
- `plan.md` — the agent's plan artifact (Planwerk reads this via
  `lib/ahp/plan-artifact.ts` for sessions with no in-tree plan).
- `events.jsonl` — the agent's internal event log (turns, tool calls, permission
  requests, mode changes). Verbose; grep it.
- `session.db`, `research/`, `files/`, `checkpoints/`, `workspace.yaml`.

### 5. Server-side logs — the dev server console
Run the app with `npm run dev` (Next.js, port 3000) and watch its terminal. Log lines are
prefixed by subsystem: `[ahp:bridge]`, `[ahp:conn]`, `[ahp:changeset]`, `[ahp:plan]`,
`[ahp:input]`, `[ahp:review]`, `[ahp:sse]`, `[heartbeat]`, `[heartbeat:card-error]`,
`[orchestrator-chat]`.
Set **`AHP_DEBUG=1`** to unlock verbose `debug()` output across the AHP layer
(`client-bridge`, `changeset-enricher`, `plan-artifact`, `enrich-card`,
`session-messenger`) and the heartbeat — invaluable for enrichment / input-fetch traces.

### 6. Telemetry logs — the host's OTLP log stream
`.planwerk/telemetry/logs.ndjson` (NDJSON; written by `lib/ahp/telemetry-logs.ts`, rotated
on connect). These are **agent-host log lines** tapped off the WebSocket
(`{ ts, level, body, scope }`) — host-side diagnostics (e.g. git/tooling errors), **not**
AHP protocol messages. Useful for host-side failures; not for inspecting card state.

### 7. Static checks — is the code even consistent?
```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # node --test lib/**/*.test.ts
```
Harness caveat: `node --test` runs modules directly, so it **cannot import** files that
use the `@/` path alias or `server-only` (most of `lib/ahp` and `lib/orchestrator`). Only
dependency-light, alias-free modules (e.g. `lib/orchestrator/coherence-detect.ts`) are
unit-tested this way. To exercise alias/`server-only` code, drive it through a live
smoke script (source 3) or replicate the pure logic in a standalone `node -e` snippet.

### 8. Git archaeology — when did this change?
Behavior regressions often trace to a recent AHP/SDK upgrade. Use blame and the pickaxe:
```bash
git log --oneline -- lib/ahp/<file>.ts
git log -p -S 'some_exact_substring' -- lib/ahp/<file>.ts   # when a line appeared
```

## Reference: key code + facts

**Code map** (where derivation happens):
- `lib/ahp/client-bridge.ts` — connect, session sync, enrichment + pending-input fetch.
- `lib/ahp/snapshot.ts` — narrow `Snapshot.state` to `SessionState` / `ChatState` /
  `ChangesetState`.
- `lib/ahp/map-session.ts` — `SessionSummary` → `KanbanCard`, phase inference, input mapping.
- `lib/ahp/enrich-card.ts` — assembles DB-backed card facts: gate status, review
  findings, escalation/coherence overlays, and `card.gateBlocker` (the
  human-readable "why isn't this advancing" reason shown when `gateStatus` is a
  silent `pending`, e.g. "Plan review not started").
- `lib/ahp/changeset-enricher.ts`, `lib/ahp/plan-artifact.ts` — file/artifact enrichment.
- `lib/ahp/protocol.ts`, `lib/ahp/protocol-rpc.ts`, and `lib/ahp/initialize.ts` —
  protocol negotiation. VS Code currently requires AHP 0.7, while npm still supplies
  the 0.5 SDK; Planwerk offers tested 0.7 and 0.6 compatibility versions ahead of the
  SDK's canonical list. Every client path uses the shared initializer, which rejects a
  host-selected version that was not offered. Unsupported-version errors preserve host
  offers and classify provably older/newer exact versions without auto-negotiating an
  untested version.
- `lib/ahp/changeset-review.ts` and `app/api/ahp/sessions/review/route.ts` — the narrow
  **AHP compatibility adapter** and mutation path for host-owned file review bits.
  This is not an official SDK migration: the adapter uses structural newer wire shapes
  until the SDK publishes matching releases.
- `lib/ahp/tool-safety.ts` — redacts `toolAuthentication` to a VS Code handoff and validates
  host-provided confirmation options/tool-safety state. Host tool safety is not Planwerk
  card risk and never advances a phase.
- `lib/ahp/types.ts` — `AHPStatus` bits + `parseAHPStatus`.
- `app/api/ahp/events/route.ts` — SSE bridge + triage entry point. Each connected board
  sends its selected workspace paths as `workspaceScope`; all automation is limited to
  the union of cards visible in those connected tabs. An unfiltered tab intentionally
  permits all workspaces. A malformed supplied scope fails closed, while an omitted
  scope preserves compatibility with older clients. The browser's “hide done” setting
  does not further limit automation because archived cards are already excluded.
  Heartbeat actions also re-project the affected card from `session_cache` plus current
  SQLite gate/review state and emit `cardChanged`; gate completion therefore does not
  wait for an unrelated AHP host event to refresh the board. Asynchronous deterministic
  commands emit `gate-completed` after their `gate_runs` row is finalized, which is the
  refresh signal that clears the evaluating state.
- `lib/orchestrator/{heartbeat,gate-engine,triage,risk-*}.ts` — the autonomous loop.
  A card blocked on Copilot's plan-review input is reviewed out-of-band by
  `plan-reviewer.ts`; the verdict is stored in `review_runs` against the current
  `plan:<hash>`. Blocking findings are returned on the **original** AHP input as
  `chat/inputCompleted(response:"accept")` with a selected answer carrying
  `freeformValues`. VS Code maps that to Copilot's
  `{ approved:false, feedback, selectedAction }`, which revises the plan without
  Planwerk declining first or waiting for a second elicitation. A passing medium/
  high-risk plan remains pending for human approval by default; inspect
  `review_policy.<risk>.auto_approve_plan` for overrides.
  A plain idle plan-phase card can still use the normal injected `plan-review` gate.
  A card that stays `running` (heads-down coding) won't advance until it idles —
  unless the opt-in `orchestrator.inject_reviews_while_busy` config is on (default
  off), which lets the heartbeat queue the review after `plan_busy_threshold` of
  continuous running. The gate still grades before advance.
  Review skills may define `prompt_by_risk` in `.github/planwerk.yml`; `skill-config.ts`
  resolves the current card risk to one prompt before the heartbeat injects the
  single configured gate.
- `lib/db/schema.ts` — tables + `getDb()`.
- `scripts/ahp-smoke.ts` — reference for live-host connection.

**Plan-approval "accepted but agent still stuck"** — if `heartbeat_log` shows a
`plan-approved` yet the card sits in plan awaiting input, check whether the
approval was *applied*, not just dispatched. `answerInput`
(`lib/ahp/session-messenger.ts`) reports `success` only after it re-reads
`SessionState.inputNeeded` and confirms the request left the aggregate
(`client.ping()` alone flushes the transport — it does NOT confirm the host
applied the answer). The presence/removal predicate is the alias-free, unit-
tested `lib/ahp/input-presence.ts` (`isInputResolved` etc.). When an accept
dispatches but never gets consumed, `runPlanApprovalPipeline` retries once then
emits a **`plan-approve-failed`** heartbeat action (mirror of
`plan-rubber-duck-failed`) instead of a phantom `plan-approved` — so look for
that action in `heartbeat_log`/the orchestrator feed.

**Plan-review feedback not applied** — look for `plan-feedback-delivered` versus
`plan-review-failed` in `heartbeat_log`. The former is emitted only after the
original request disappears from `SessionState.inputNeeded`. For the latter, inspect
the latest `review_runs` row: `changeset_ref` must match the card's current
`planContentHash`, `verdict_summary`/`findings_json` contain the independent review,
and `status` distinguishes a passing review, blocking findings, and escalation.
Do not look for a follow-up ask-user request: the old decline-then-follow-up flow was
removed because AHP decline intentionally carries no plan feedback.

**AHP status bits** (`lib/ahp/types.ts`) — decode a raw `status` number:
`Idle=1`, `Error=2`, `InProgress=8`, `InputNeeded=24` (**composite** `8|16`),
`IsRead=32`, `IsArchived=64`. `InputNeeded` includes the `InProgress` bit — test it as
`(status & 24) === 24`, not a plain AND.

**Changeset freshness / gate staleness** — why a *passed* gate can re-trigger.
A gate/review verdict is invalidated ("stale") when the card's current changeset ref
differs from the ref the gate ran against (`gate_runs.changeset_ref`,
`review_runs.changeset_ref`). Two ref shapes, both compared via
`normalizeChangesetRef` (`lib/types.ts`):
- **Code ref** `files:additions:deletions:modifiedAt` (modifiedAt dropped when normalized).
  Used for `build->review` and `review->ship`. Derived from the card's diff counts —
  which now come from the **session-scoped** changeset (`changeKind:"session"`, isolated
  per agent) via `changeset-enricher.ts`. Current VS Code also derives
  `SessionSummary.changes` from that session changeset, but Planwerk marks counts verified
  only after reading a ready per-file snapshot itself. When `card.changesetVerified` is
  false, the ref is treated as **unknown** (`undefined`) and never marks a verdict stale.
- **Plan ref** `plan:<hash>` (opaque identity of `plan.md` content, hashed in
  `changeset-enricher.ts` / merged in `client-bridge.ts`). Used for `plan->build` reviews
  (`plan-review` = `/rubber-duck`) so unrelated code churn — or another agent's edits —
  can't re-trigger a passed plan review. Carried on `card.planContentHash`.

Empty/unknown current ref ⇒ **never stale** (guarded in `gate-engine.getLatestPassingRuns`,
`review-executor.shouldStartReview`, `types.isGateRunStale`). If a passed gate keeps
re-injecting, check: (a) is `changeset_ref` flapping between a real value and `0:0:0`
(unverified summary leaking in)? (b) for a plan gate, is `changeset_ref` a `plan:` ref on
both the run and the card? Pure-logic tests live in
`lib/orchestrator/changeset-freshness.test.ts`.

## A sane order of attack

1. **Reproduce the claim from data**, not intuition — dump the card's `card_phases` row
   and `session_cache` (sources 1–2) to see persisted phase + the facts it was derived from.
2. If facts look stale/missing, go to the **live host** (source 3) and the agent's
   **session-state files** (source 4) to get ground truth.
3. Turn on **`AHP_DEBUG`** and watch the **dev server logs** (source 5) to see the
   derivation/enrichment/input-fetch path execute.
4. Confirm the exact card id: `copilotcli:/<uuid>` — the app's own dogfood session is a
   card too, so make sure you're inspecting the *right* one before drawing conclusions.
5. If a card is unexpectedly not being automated, inspect the workspace filters in every
   connected board tab. Cards outside their union are intentionally deferred: triage,
   gates, reviews, nudges, auto-answers, phase advances, and coherence checks do not run.
