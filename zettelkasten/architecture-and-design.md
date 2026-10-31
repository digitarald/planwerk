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

#### Independent plan-review evidence

Current `ahp-session:/` identities belong to the host, not to an SDK
conversation directory. Planwerk reads a pending request's published
`planReview.planUri` through the host and verifies the original chat/request
turn. It never guesses a backing SDK UUID or retains legacy discovery.
An unambiguous in-tree plan can also come from a ready session changeset.

The independent peer receives the complete plan text and provenance explicitly;
plain `createChat` does not inherit the writer's conversation. Plan reviews
always use `plan:<sha256-of-exact-text>`, independently of the persisted column.
Code gates retain their verified `source:` revisions. Missing, denied, changed
or incomplete evidence cannot approve a plan or fall through to generic
auto-answering.

Plan reviews are report-only in every coordinator mode. Source-byte comparison
before verdict acceptance supplements edit-tool detection; unknown or changed
session resources cannot pass. This verifies host-reported changeset resources,
not an unrestricted filesystem or a read-only sandbox. The existing judgment
lease and atomic review/gate commit also check current cached plan authority.

Peer chat/turn identities are reserved before creation. Uncertain dispatch
remains quarantined even after disposal; duplicate starts reuse existing work.
Automatic feedback/approval reserves a durable original-request receipt before
dispatch and confirms consumption from host input removal. It cannot replay
after an uncertain outcome. Human input remains explicit, and only the gate
engine changes phase forward.

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

#### AHP client practices

- Keep one root catalog observer per logical host, shared by board subscribers.
  Follow catalog pagination; track ownership and source revisions independently
  from which cards the user displays.
- Treat session/chat subscriptions as operations that can restore provider state,
  not passive reads. Cold and archived sessions stay catalog-only. Live reads
  require an active session, one observed completion, or an explicit authorized
  action; use the existing read-policy and operation-client helpers.
- Separate catalog metadata from expensive card projection. The default
  `/api/ahp/events` stream projects non-archived cards and an `archivedCount`.
  An optional `view=archived` stream projects archives from catalog/cache facts
  only when the user shows them. Both streams share the same host bridge; toggling
  archives neither reconnects AHP nor authorizes automation.
- Cache archive projections within a host generation and invalidate them on
  catalog updates. Archive/unarchive/removal events update both views; the client
  merges snapshots and applies removals only to their originating view.
- Keep cached snapshots display-only, archive projection read-only, model work
  off the event-delivery path, and unchanged cache rows untouched on reconnect.
  Do not trade revision/ownership checks for speed or make history current by
  changing timestamps.
- Retain per-subscriber ordering and byte budgets. A slow archive reader must
  not disconnect the active board or another host.

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

### AHP 1.0 runtime facts

Cached SSE initialization is display-only. The heartbeat receives cards only
after that host's current bridge generation has projected a live catalog.
Bridge payloads are cloned and projected synchronously so later mutations cannot
erase intermediate states. Model triage runs separately through a shared bounded
assessment lane (two independent cards, one assessment per card at a time).
Identical facts share work; queued obsolete revisions are superseded, and queue
overflow is explicit and recoverable by reconciliation. Failed SSE triage for the
same digest has a one-minute cooldown. A late result reprojects current facts
rather than broadcasting its captured card. Producer closure and consumer cancellation both
release inbox listeners; failed listeners do not interrupt other subscribers.

Each SSE subscriber receives an epoch and sequence. Browser callbacks from retired
connections are ignored; gaps require a new snapshot. Cached initialization does
not mark the host live, and persisted phase/gate truth is already in the server
snapshot, so the browser does not race it against separate phase hydration HTTP
requests. Projection may seed a new live card's phase, never advance an existing
persisted phase. Each Web Streams subscriber queue is capped at eight MiB;
slow consumers disconnect independently. This bounds the application queue, not
every TCP/proxy buffer. Oversized snapshots return an explicit terminal error.

Every build offers only AHP `1.0.0`; there is no older-version fallback or retry
with an untested host version. The SDK dependency is pinned to that release.

Root-channel session summaries preserve the host's ordered lightweight chat
catalogue and `defaultChat` routing hint, including per-chat status,
interactivity, and aggregate change counts. Missing chat status remains unknown.
Hidden chats are omitted from the UI. Read-only chats remain visible, while
message dispatch checks both the fresh session catalogue and chat snapshot
before sending to the default chat.

Cold sessions stay catalogue-only because subscribing can restore their
provider. Active chat observers use the lightweight catalogue when available;
a parent-session subscription supplies missing chat discovery or routing data.
Once established, observers survive idle and input-needed states so shells and
subagents in `ChatState.backgroundWork` remain visible until the host removes
them. Hidden, archived, and removed chats release their observers.

Catalog timestamps are freshness hints, not evidence of a user or assistant turn.
VS Code may restore a cold provider on subscribe; SDK resume/shutdown journal
writes can then change the session's displayed recency
([upstream issue](https://github.com/microsoft/vscode/issues/342118)).
Timestamp-only updates may invalidate cached file/plan evidence, but never
authorize enrichment, input refetches, or dirty enrichment retries. Cold startup
and idle catalog changes remain subscription-free, including explicit content
revision changes. New chat observers also require an active parent session.

The inbox reconciles session-backed handoffs against a successful, complete live
catalog before board archive/workspace filtering. Missing or disabled sources,
archived requests/readiness, and requests whose runtime no longer needs input are
resolved automatically. Cached, partial, failed, and disconnected inventories do
not authorize cleanup. Live single-session updates reconcile only that source;
host ownership/quarantine still gates mutations. Human actions survive cleanup.

An input-needed summary without a hydrated question is unknown, not a removal.
Known requests survive reconnects and failed reads. A genuinely unavailable
question gets a source-linked Open session notice, replaced by the real request
when fetched. A matching request can recover an automatic false resolution, but
not an explicit human resolution or snooze. This never answers a question.

Inbox briefing JSON retains the source session title, project, and workspace even
when the board card disappears. Authoritative source observation is separate from
handoff age and synthesis generation time: cached reprojection and synthesis do
not renew it. Metadata refresh preserves ordering, read/pin state, and synthesis.
The UI shows unavailable, unverified, disconnected, and over-30-minute stale
sources, and refreshes age while open. Source freshness never verifies a gate.

An observed active-to-idle/error transition permits one final enrichment read,
including zero-file outcomes. Queued work rechecks eligibility after connection
acquisition; completion permission is consumed once. The session subscription
stays owned through dependent chat/changeset reads to avoid evicting and restoring
between them. Removed/archived sessions and disposed bridges reject late results.
Background coherence and auto-answer validation check the passive catalog before
reading live state. Explicit inspection, send, resume, and authorized review
operations retain their intentional live reads.

AHP 1.0 has no advertised non-restoring session-snapshot operation. Catalog
checks are not atomic residency guarantees, and even a bounded completion read
can race host eviction. When freshness changes during a read, its file/plan
facts are discarded rather than relabelled current or repeatedly restored.
Without an immutable host revision, the timestamp/count digest remains only a
conservative cache-binding fence, not a content-change notification. Missing
facts wait for real activity or explicit inspection.

**Refresh evidence** is an intentional operation, available in card details via
`POST /api/ahp/sessions/evidence`. It may restore a cold session. It invalidates
old authority, retains residency through collection, and commits only while the
catalog fence, observed streams, cache token, and refresh generation still match.
Collection supports up to 256 files and 32 MiB of cumulative decoded resource
bytes, with a 30-second collection deadline including connection acquisition.
Unsupported limits return 422; deadline expiry returns 503. AHP resource reads
have no range parameter, so an unsized individual response can arrive before
the client rejects it; this is not a pre-transfer bandwidth bound.
Captured-byte evidence digests are separate from file-metadata/manifest digests.
They identify the captured evidence, not a guarantee that unsupported hosts can
report every subsequent edit. No new AHP method or immutable-revision capability
is inferred from a generic metadata field.

Session URIs remain legacy card identifiers, so a second host claiming an
existing URI is quarantined rather than overwriting cache/authority. Historical
phases and audits are preserved, but ambiguous ownership cannot authorize gates,
risk, coherence, or phase movement. This is a deliberate fail-closed alternative
to an incomplete cache-only composite-key migration.

Card details use one compact evidence disclosure rather than another dashboard.
Its summary distinguishes evidence, activity, review-budget, service, gate and
ownership waits; expanded content explains the supported next step. Capture
provenance records the actual collection time/method/coverage and survives
invalidation as stale metadata, never as current gate authority. Refresh warns
visibly that it can restore a session and change its activity timestamp.

An ownership conflict stays visible as a passive, display-only catalog entry.
Only that state exposes host recovery controls. The operator chooses a recorded
host and explicitly confirms invalidating old authority while retaining phase
and audit history. The ownership API checks the selected host's passive catalog,
requires a revision CAS and refuses active or ambiguous work. Recovery is
recorded in `session_ownership_recovery_audit`; reconnect alone cannot clear
quarantine or reclaim a deliberately rejected host. A new, unknown claimant
quarantines the URI again. Recovery does not approve gates or collect fresh
evidence; a deliberate refresh is required afterward.

Heartbeat work has an admitted host/session, source, phase, scope, capability
and generation. Rechecks precede effects and authoritative commits. Dirty-key
wakeups coalesce with the periodic sweep; card mutations stay serial and WIP
admission counts persisted occupancy, not only automation-eligible cards.
Retiring a generation invalidates authority before bounded draining. An unsettled
same-session mutation retains its process-local admission slot or quarantine;
the scheduler timeout alone does not make it safe to retry. Accepted remote
effects cannot be retracted by client cancellation. Cross-process recovery still
depends on the existing durable run leases and ambiguity records.

Each observed chat's static changeset catalogue is followed through its own
channels. Card details show scoped file facts, and board cards show active
background-work counts. Computing, recomputing, errored, and unavailable
changesets do not expose current files. Templated per-turn and comparison views
are not expanded. Shared changeset channels use reference-counted ownership;
only the last observer releases the server subscription.

Explicit AHP operations retain parent residency through dependent reads and
dispatch, and reduce authoritative echoes for input, archive, resume, and file
review confirmation. Cancellation closes the operation's exclusive client;
post-dispatch uncertainty is reported as ambiguous rather than safely retryable.
Missing/unready snapshots never count as verified archive state.

Desktop discovery shares one probe batch across concurrent callers. Each probe
has a 15-second total deadline, with bounded cleanup; local and remote WebSocket
handshakes also have a 15-second deadline. Cancelling a discovery waiter does
not cancel another caller's shared probes. Ordinary RPC request timeouts retain
the SDK default unless explicitly supplied. Provider-specific artifact misses
are scoped to one bridge generation across its transient clients, not shared
between hosts or reconnects.

Coherence signatures include both verified source revisions, not only file
paths and line counts. Review collection requires complete session-scoped file
evidence, with current host, source, and lease bindings checked before SDK work
and verdict commit. Reconciliation is host-scoped; absence from a filtered or
incomplete eligibility batch is not authoritative removal. Deferrals distinguish
waiting for activity/new evidence, retryable infrastructure failure, invalid
model output, and unsupported evidence budgets. Unsupported/oversized reviews
do not retry model work indefinitely. Evidence beyond the bounded file/content
budget remains unsupported, not a completed review; lossy chunk summaries cannot
establish cross-file coherence.

Explicit refresh stores digests, not nonartifact code bytes. It can recover gate
evidence on an idle card, but cannot itself supply cold-session code to an LLM
coherence review. Such a pair remains blocked without periodic subscriptions;
automatic review requires both sessions active, or a human may deliberately
accept divergence for the current revision. Legacy coherence rows with ambiguous
host ownership likewise remain blocked pending explicit recovery.

Chat changesets and background work are informational. They never contribute
to session change totals, gate freshness, phase transitions, or coordinator
authority. Verified session-scoped changesets remain the source of file evidence
for those existing workflows. See `lib/ahp/chat-facts.ts` and
`lib/ahp/client-bridge.ts` for observation and ownership.

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

SDK cleanup is bounded per abort, delete, disconnect, stop, and force-stop step;
a hung step cannot prevent later cleanup attempts. Cleanup timeout failures
retire the exact leased runtime generation. Coordinator creation records local
ownership before checking lease/cancellation again, so a newly created unbound
orphan is deleted without touching a replacement binding. Child-agent
error/shutdown events do not cancel the primary coordinator's action policy.

The CTO uses one restart-safe Copilot SDK conversation whose ID is stored in
SQLite. The shared SDK runtime uses `mode: "empty"` and an explicit
`dataDirectory()/copilot-sdk` base directory, which overrides the spawned
runtime's `COPILOT_HOME`; it never attaches to the desktop runtime or falls back
to the global Copilot session directory. Runtime startup and health checks do not
list or resume sessions. The coordinator checks metadata only for its persisted
ID; unrelated sessions are never candidates for continuity.
Every request acquires an expiring SQLite lease, resumes the conversation,
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
