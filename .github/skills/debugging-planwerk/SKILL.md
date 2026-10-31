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
`cto_sdk_sessions`, `cto_session_leases`, `gate_configs`, `gate_runs`,
`heartbeat_log`, `inbox_items`, `inbox_item_actions`, `review_chat_cleanups`,
`review_runs`, `session_cache`.

Chief-of-staff goals use `coordinator_goals`, `coordinator_work_items`, and
`coordinator_dependencies`. Inspect state, revision, saved `workspace_scope_json`,
claim owner/expiry, item `action_key`, baseline, delivery, and outcome evidence.
`coordinator_goal_commands` stores idempotent goal-edit receipts;
`coordinator_deliveries` reserves the actual resource/chat/message identity before
a create or send. An uncertain item is never blindly retried. A queued
`pendingMessageId` is not proof of an eventual turn or successful result.
`coordinator-goal-reconciler.ts` runs on the existing heartbeat and logs explicit
failures as `[coordinator:goal]`. Unchanged outcome evidence does not trigger
another judgment. Observe/downgraded modes, disconnected hosts, and workspaces
outside saved scope intersected with the connected automation scope leave goals
persisted without authorizing future effects. The drawer's goals section and
`GET /api/orchestrator/goals` show the current wait reason; host-scoped
`coordinatorGoalsChanged` SSE events refresh it. Only completed/needs-human
goals project to the inbox through stable goal-specific source keys.
Coordinator chat reads the same live server catalogue and policy as heartbeat.
`list_sessions` exposes bounded pages; `read_session_messages` returns the latest
cached agent outcome only, not a transcript. Missing outcomes must be explicitly
inspected or refreshed, not recovered by subscribing to every cold session.
`enrichment_json.outcomeEvidence` contains the latest completed chat/turn identity,
bounded text, and truncation flag. Goals require that identity to match their
recorded dispatch. A legacy message snippet, truncated outcome, or unrelated
later turn cannot release dependencies.

```bash
node -e '
const db = require("better-sqlite3")(".planwerk/planwerk.db", { readonly: true });
for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all("table")) console.log(r.name);
'
```
Good first queries: `card_phases` (persisted column), `heartbeat_log`
(what the orchestrator did/decided, newest `id` first), `gate_runs` / `review_runs`
(gate outcomes + staleness), `card_risk` (triage verdict driving gate intensity).
The active inbox is intentionally not a history table: unpinned completion notices
expire after one hour, while pending input, approvals, errors, failed gates, and
conflicts remain source-resolved. `inbox_item_actions` distinguishes explicit human
resolution from automatic projection cleanup; the Done view should contain only the
former.
Completion is valid only while the source session remains idle or archived. A later
running, input-needed, or error snapshot source-resolves the item and emits
`inboxRemoved`, even when another client steered the session. Final chat enrichment may
arrive after the idle transition; `projectExistingCompletionRefresh` updates an existing
open completion from `lastAgentMessage` without replaying every historical idle session.
Every projected upsert also queues a non-blocking Copilot SDK Chief of Staff synthesis.
The model authors one free-form inbox note plus delivery metadata (headline, attention,
and executable action intents); it never determines phase, runtime, gates, or inbox
lifecycle. Generation is keyed to a digest of bounded source evidence and applies only
while the same source revision and request remain open. Late results are discarded.
The synthesis request digest intentionally excludes volatile card telemetry such as
runtime attention and recent activity. It changes only with the task identity, source
revision, or deterministic source note. Inbox completion/readiness revisions likewise
fall back to a digest of user-relevant outcome evidence rather than `modifiedAt`, so
host residency or polling churn cannot repeatedly paraphrase an unchanged result.
Board-level WIP-limit violations remain coordinator telemetry and are intentionally not
projected into the human inbox because they do not identify a specific handoff. A breach
emits once when the phase crosses above its configured limit and clears when the phase
returns to capacity. If a WIP row appears in `inbox_items`, inspect
`purgeNonActionableInboxItems`; host-scoped keys have the form
`host:<encoded-host>:orchestrator:wip:<phase>`.
Inspect `briefing_json.synthesis` for `pending`, `generated`, or `failed`, the request
digest, model, and generation time. `INBOX_BRIEFING_MODEL` optionally pins this workload;
otherwise it uses the normal triage model policy. A failed call leaves the deterministic
source note visible and is retried only after the cooldown or when source evidence changes.
In rolling-worker deployments, active work is lease-fenced rather than reset merely
because another process opened the database. Inspect `gate_runs.owner_id` /
`lease_expires_at_ms`, `review_runs.start_owner_id` /
`start_lease_expires_at_ms` (pre-dispatch) and `judgment_owner_id` /
`judgment_lease_expires_at_ms` (verdict extraction), plus
`coherence_conflicts.review_owner_id` / `review_lease_expires_at_ms`. Startup recovery
uses atomic expiry checks: a future lease must survive, while an expired pending review
claim and its linked running gate are terminalized together before a later retry.
Immediately before a review prompt side effect, `review_runs.status` becomes
`dispatching` with reserved `chat_uri`/`turn_id`, `dispatch_host_url`, and
`dispatch_chat_disposable`. An expired `dispatching` row is never retried: recovery
marks it `ambiguous`, fails its gate, and records the exact identity in
`review_chat_cleanups` for peer-chat disposal or default-chat quarantine.
For CTO conversation release, inspect `cto_sdk_sessions.lifecycle_state`,
`deletion_token`, and `deletion_started_at_ms` alongside `cto_session_leases`.
Release first moves the active binding to `deleting`; only a fully successful
disconnect restores it to `active`. Any reported failure leaves the binding
quarantined so a later owner must confirm bounded deletion before replacement.
Both restoration and deletion use session-, token-, lease-owner-fenced CAS.
`card_risk.risk_digest` must be non-null and match the digest derived from the
current `session_cache` row plus `card_phases` row. Missing, null-digest, or
mismatched assessments are intentionally non-authoritative: heartbeat logs one
`risk-assessment-required` blocker only when authoritative facts are unavailable
or reassessment fails, while gate/reviewer reads use high-risk policy. Observe
mode automatically reassesses missing, unbound, or stale risk for automation-
eligible cards; incomplete facts resolve deterministically to high risk without
an SDK call. Ship, archived, and idle Define cards are not automation-eligible
and must not show a risk blocker. The shared eligibility predicate is
`lib/orchestrator/automation-eligibility.ts`; the canonical risk reader is
`lib/orchestrator/risk-authority.ts`.
SDK failures and invalid model output use `risk-classifier.ts`; incomplete
counts-only facts and sensitive auth/security/permissions/schema/migration or
destructive-operation file paths are deterministically high risk. Prose is
interpreted by the model, not used as a keyword-based pre-model floor. Prose keywords
and size thresholds remain conservative SDK-failure fallback signals.
The model's shared rubric evaluates impact, blast radius, reversibility, exposure,
and uncertainty. Only complete,
revision-bound per-file facts can receive a lower fallback assessment.
`risk_assessment.guidance` from the working directory's nearest configuration
is part of `RiskInput` and its digest; `RISK_POLICY_VERSION` also invalidates
assessments when the rubric changes. Inspect these before reusing an older verdict.
`review_chat_cleanups` records peer-chat disposal by normalized
`(host_url, chat_uri)`. Retries are host-scoped and bounded to three total
attempts per row. The global heartbeat scans every persisted host; an origin
does not need an active board stream for retry. A `quarantined` row has no
recoverable originating host and must never be retried against whichever host
happens to be active.

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
Successful no-code outcomes and runtime-error details are transcript facts, not
changeset facts. When Planwerk is already allowed to perform a live enrichment
(an active session, a relevant host event such as active → idle/error, or an
explicit user/orchestrator action), it reads the session's `defaultChat` and
persists `lastAgentMessage` and/or `runtimeError` in `enrichment_json` even when
the session reports zero changed files. If an idle completion says its outcome
was not captured, or an error card has only a red status badge, inspect whether
that transcript-only enrichment was produced and source-bound.

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
`listSessions` is a passive catalogue read. Subscribing to a session or one of
its chats is not: VS Code Agent Host may restore evicted state, invoke the
provider's resume path, refresh session git state, pin residency, and bump the
Copilot CLI session's `modifiedAt`. Planwerk startup must therefore remain
catalogue-only for cold sessions. It reads live session state only for sessions
already `InProgress`/`InputNeeded`, for one final enrichment after an observed
active-to-idle/error transition, or while carrying out an explicit
user/authorized orchestrator action. A cold cache, missing enrichment, a
timestamp-only event, or a new host URL must never fan out subscriptions across
the session catalogue. A cold chat cannot bypass this through a stale
`InProgress` chat summary: new observers require an active parent session.

`modifiedAt` is not evidence of a turn. A session subscription can cause SDK
resume/shutdown journal writes and change the timestamp that VS Code displays as
recency. The bridge uses timestamp/count fallback revisions only to invalidate
uncertain cached facts, never as permission to subscribe. Its dirty queue
rechecks eligibility after connecting and cannot retry a consumed completion
read. Enrichment keeps the session subscribed through dependent reads; late
results are discarded on revision drift, removal, archiving, or bridge disposal.
Background coherence and auto-answer validation use `readActiveSessionState`
to check the passive catalog first. AHP 1.0 offers no non-restoring snapshot
operation or atomic residency check, so a completion read can still race host
eviction. Do not label old file/plan facts current to hide this limitation.

The direct SDK lane is separate: `sdk-runtime.ts` configures empty mode and
`dataDirectory()/copilot-sdk` as its explicit base directory. Health checks do
not list/resume sessions, and `cto-session-manager.ts` only checks metadata and
resumes the SQLite-bound coordinator ID under its existing lease. It must not
discover continuity by scanning global `~/.copilot` history.

For startup automation, inspect the SSE host partition's `resource.connected`.
Cached initialization is display-only; `getAutomationHosts` excludes a host until
the current live catalog has been projected. Bridge events are cloned and projected
synchronously; model triage is off the delivery path and shares the bounded
assessment lane with heartbeat. The browser rejects old epochs/duplicate sequences
and no longer races SSE against phase hydration HTTP calls. Cached snapshots do
not count as a live connection. Server-side stream closure
must remove inbox listeners just as consumer cancellation does.

The default SSE stream projects non-archived cards only and includes an
`archivedCount` derived from enabled archive catalog entries with code changes.
The browser opens a separate `view=archived` stream only while archives are shown.
It shares the existing host bridge, projects catalog/cache facts without live
session reads or status/phase writes, and has no automation scope. Archive
projections are cached per host generation and invalidated by catalog events.
The active partition's `cards` never includes archives. Check both streams when
debugging archive/unarchive races: snapshots merge by view, removals are
view-scoped, and hiding archives closes only the archive stream. Identical
summary/enrichment cache rows are not rewritten on reconnect.
See `zettelkasten/architecture-and-design.md` for the AHP client practices.

Each subscriber's Web Streams queue has an eight-MiB byte budget. A slow reader
disconnects without stopping other subscribers; an oversized snapshot is an
explicit terminal error. This is not a promise about proxy/TCP buffering. The
synthetic event-stream test measures ingress-to-reader separately from browser
paint; its 1000-event small-payload budget is not a live-host performance guarantee.

Use the card's explicit **Refresh evidence** action (or
`POST /api/ahp/sessions/evidence`) to collect plan, files and outcome intentionally.
It may restore a cold session and change its activity timestamp. Observe
`evidenceDigest` separately from legacy manifest `contentRevision`: the former
hashes captured bytes but does not prove that an unsupported host will report
every later change. Superseded refreshes, changed captures and cache-CAS failures
must not be committed as current.

Explicit capture budgets are 256 files, 32 MiB cumulative decoded bytes and a
30-second collection deadline. Inspect the evidence API's 422 unsupported detail
(`file-limit`, `byte-limit`, `changeset-template`) or 503 deadline detail before
retrying. Resource reads have no range parameter; these are post-response byte
checks, not a pre-transfer bound on an unsized host response.

An identical session URI claimed by another host is a persistent ownership
quarantine, not a reason to move historical phases or reuse another host's facts.
Inspect `session-ownership.ts` and cache snapshot/CAS helpers before clearing or
migrating those records. Quarantined projection is display-only.

Ownership conflicts remain visible on the board, without enrichment, input
or worker subscriptions. The card's evidence disclosure shows the recorded
host choices only for a conflict. `GET /api/ahp/sessions/ownership?sessionUri=...`
returns redacted host labels and opaque IDs; explicit `POST` recovery requires
the selected ID, expected revision, and confirmation. It validates the passive
catalog and refuses active/ambiguous work, preserves phase/history, invalidates
old evidence/risk/gate/review authority, and writes
`session_ownership_recovery_audit`. Known rejected hosts cannot silently reclaim
ownership on reconnect. Unknown hosts still quarantine.

`card.automationWait` is explanatory, not authorization. It distinguishes system
waits from human input and exposes a next step/retry time where supported.
`card.evidence.capture` records actual `capturedAt`, `source` and `coverage`;
`session.lastEvidenceCapture` retains that provenance after invalidation.
Do not replace collection time with catalog `modifiedAt`, or show a past byte
capture as a current approval. All of this fits in one disclosure in card
details; it does not create human inbox work.

Explicit operations retain session residency through dependent chat/changeset
reads and reduce host echoes for confirmation instead of re-subscribing to poll.
Missing/unready snapshots cannot verify archive state. Cancellation closes the
owned client, while post-dispatch uncertainty stays an ambiguous operation.
SDK abort/delete/disconnect and runtime stop/force-stop each have bounded cleanup;
timeouts retire the exact leased runtime generation. A child-agent error/shutdown
does not cancel the primary coordinator's policy.

Discovery is single-flight and each candidate has a 15-second total probe
deadline. Both local and remote WebSocket handshakes have 15-second deadlines;
ordinary RPC requests keep their SDK timeout. Artifact negative caches belong
to one bridge generation across its temporary clients. A miss on another host
or a previous connection must not hide a current plan.

For coherence, inspect the versioned source-bound signature and
`review_lease_expires_at_ms` and the structured deferral state. Inactivity/new
evidence waits differ from infrastructure backoff and unsupported evidence
limits; neither unsupported inputs nor repeated invalid output should spend
model work forever. Reconciliation is host-scoped and a missing card in an
eligibility-filtered batch must not clear a blocker. Ship checks reopen stale
settled verdicts rather than reuse a count-identical old review.

Refresh persists code digests, not reviewable code bytes. An inactive coherence
pair therefore cannot be reviewed from a digest or woken into background cold
subscriptions by refreshing it. Activate both sessions for automatic review or
use the explicit revision-bound accept-divergence action.

Heartbeat dirty-key wakeups supplement the periodic sweep. Operation admission
rechecks host/session, source, phase, scope, mode and generation before effects.
A bounded scheduler drain retires authority, not necessarily an already-accepted
remote command. Same-session unsettled mutations retain their admission slot or
quarantine; never reset it merely to make a timed-out request retryable.

Cold cards without a current authoritative gate revision are parked by the
heartbeat: they do not enter automation, coherence, or WIP counts. Missing
enrichment and revision facts are retryable system conditions, not human work;
`source-revision-required` and `risk-assessment-required` may be recorded in
`heartbeat_log` for diagnosis but must not appear in `inbox_items` or the
coordinator feed. If the inbox floods with those diagnostics or WIP counts
include cold catalogue entries, inspect the heartbeat candidate filter around
`resolveAuthoritativeGateRevision` before changing AHP subscription behavior.

The smoke harness intentionally performs a live read of its selected session and
can therefore restore that session. Do not run it across production sessions when
investigating timestamp or residency side effects; use `listSessions`-only
evidence first.
It reads schema-v2 editor entries from VS Code Stable and Insiders user-data registries,
validates live processes, connects to each token-protected Unix socket, and chooses the
compatible host with the largest full paginated catalog (then newest endpoint, then path).
The logical endpoint is stable even when VS Code rotates the socket and connection token;
its cache key is intentionally not the ephemeral filesystem path.
For a VS Code instance launched with a custom `--user-data-dir`, set
`AHP_VSCODE_USER_DATA_DIR` to that directory before starting Planwerk.

The standalone TCP server is still useful for an explicit, isolated host:
```bash
code agent host --host 127.0.0.1 --port 8082 --without-connection-token
```
It creates a distinct Agent Host and can therefore have a separate, empty session
catalogue. Do **not** use it as evidence that the desktop catalog is empty.

When the board is empty, distinguish these diagnostic states before changing code:
- `vscode-local://desktop` reports no endpoint: no live editor entry was found in VS
  Code's local endpoint registry. Desktop VS Code starts Agent Host automatically when
  AI features are enabled; there is no fixed port or separate **Chat: Agent Host**
  setting. Keep desktop VS Code open with GitHub Copilot enabled and retry. Planwerk
  intentionally does not fall back to a standalone host.
- The selected host has `totalSessions: 0`: the host catalog itself is empty.
- `totalSessions > 0` with `visibleSessions: 0`: every catalog entry was filtered
  because it is archived without code changes or its folder configuration sets
  `enabled: false`. These are intentional board filters.
  `lib/orchestrator/config-file.ts` discovers the nearest `.github/planwerk.yml`
  or `.yaml` from each local working directory up to its repository root
  (`.yml` wins ties; nearest configuration replaces parent configuration).
  SSE filters cached/live cards before board, triage, and inbox projection;
  the automation-host selector rechecks enabled state on each read.
  Reconnect after editing to refresh the full board/workspace list. A multi-folder
  session is hidden if any folder is disabled. Old inbox history is not erased.
- Multiple compatible editor candidates: diagnostics record the chosen catalog size and
  selection rule. A host with more sessions wins, so an empty standalone instance cannot
  hide an active desktop catalog.
- No compatible editor candidates: Planwerk preserves structured handshake evidence. When
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
`readSessionState` and `readChatState` from `lib/ahp/snapshot.ts`, and
`asChangesetState` from `lib/ahp/changeset-readiness.ts`, to narrow snapshots.
Standalone SDK scripts run under
`node --experimental-strip-types` and can import `../lib/ahp/*.ts` **relatively** (the
`@/` alias does not resolve outside Next/tsc).

VS Code's **All Changes** entry is the static catalogue item whose
`changeKind === "session"`. Its subscribed snapshot can initially be
`status:"computing"` or `status:"recomputing"`; a client must briefly reduce the subsequent `changeset/*` actions
into that snapshot until `changeset/statusChanged` reports `ready`, or keep the result
unknown and retry. Do **not** re-subscribe to get a fresh snapshot after readiness:
current VS Code starts another computation for each subscription. Closing immediately
on the computing snapshot can leave `changesetVerified:false` even though VS Code later
renders the completed All Changes view.
Every fresh changeset subscription may also start a new computation. Consumers must use
`readReadyChangesetState` to reduce the existing subscription through `ready`/`error`
rather than close a `computing`/`recomputing` snapshot and subscribe again. Retained
files during recomputation are not current evidence. This applies to card
enrichment, file-review mutations, and coherence reads.

Subscription ownership is URI-global within one SDK `AhpClient`, not local to the
returned `Subscription`: `Subscription.close()` stops only that iterator, while
`client.unsubscribe(uri)` drops the server subscription and every local consumer for the
URI. Do not overlap a one-shot read and a long-lived observer for the same URI on a shared
client. Prefer one subscribed reducer, serialize operations, or use separately owned
clients. Repeated subscribe/unsubscribe polling also touches residency and can repeatedly
restore cold state; consume actions from the original subscription when possible.
The live chat-facts observer in `lib/ahp/chat-facts.ts` reference-counts shared
changeset channels and unsubscribes only when their last observer releases them.
It follows `chat/changesetsChanged` and clears scoped file facts while a changeset
is computing, recomputing, errored, or unavailable. These facts never replace the
session changeset used by gates.

Before subscribing to inspect workers, check `SessionSummary.chats` and
`defaultChat` on the root catalogue. Preserve missing chat status as unknown and
respect `interactivity`: hidden chats are omitted, read-only chats accept no
messages. Existing live observers continue through idle/input-needed states;
`ChatState.backgroundWork` and `chat/backgroundWorkSet`/`Removed` report active
shells and subagents independently of turn lifetime. Ending or removing a chat
releases its observers and clears background facts.

Planwerk's imperative routes and orchestrator helpers use `lib/ahp/client-operation.ts`
for one exclusive connection per logical operation; the board bridge keeps a separate
persistent observer client and performs one-shot enrichment/input reads on operation clients.

Detailed completion/error truth lives on the default chat. Its `ChatState.turns`
tail is oldest-first; the latest completed turn is the last entry. Successful
outcomes come from agent-authored markdown response parts. A runtime failure is
authoritative only when the latest turn has `state:"error"` and its final response
part is `kind:"error"`; the nested `ErrorInfo` carries `errorType`, `message`,
optional `stack`, and the part's `resumable:true` is the only condition that permits
`chat/turnResume`. Session creation failures instead use
`SessionState.creationError` and are never resumable through that action.
Planwerk intentionally does not subscribe to every cold idle/error session at
startup. Opening a card whose outcome/error detail is missing uses the guarded
`/api/ahp/sessions/details` explicit-inspection path; resume uses
`/api/ahp/sessions/resume`, which re-reads and verifies the same chat/turn identity
before dispatch.

### 4. Copilot CLI per-session files — what the agent actually did
`~/.copilot/session-state/<session-uuid>/` (the UUID is the tail of a legacy
`copilotcli:/<uuid>` card id). Current `ahp-session:/<uuid>` identities are host-owned
and need not match the underlying SDK conversation UUID. Peer chats have separate
SDK conversation directories as well. Resolve the actual backing before inspecting
files; do not construct its path from an AHP session or chat UUID.
`lib/ahp/plan-artifact.ts` currently recognizes only legacy `copilotcli:/` IDs, so
an empty artifact list for an `ahp-session:/` card does not prove its plan is absent.
Contents worth reading:
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

The browser persists the last logical host in the `planwerk-connection` local-storage
entry and reconnects during Zustand hydration. A startup line such as
`[ahp:sse] remote stream → ws://localhost:<ephemeral>?tkn=...` means old browser state
restored a rotated editor endpoint instead of `vscode-local://desktop`. Current versions
migrate legacy loopback token URLs to desktop discovery. During mixed-version debugging,
click **VS Code (local)** or remove `planwerk-connection` from local storage.

The global coordinator-mode hydration request sends only `hostUrl`; the server returns
all overrides for that host and the client computes effective defaults for visible cards.
If a large board reports `Coordinator mode request failed (431)`, inspect whether an
older client is still putting every card ID in the query string.
Persisted phase/gate truth now comes in the server's SSE snapshot. The live hook
does not issue a second `/api/gates/phases` hydration request that could race a
newer stream or a host switch. That endpoint remains for compatibility; a `431`
from it indicates an older client or another caller serializing a catalog into
one URL, not a reason to increase server header limits.

If the browser reports that it could not open the Planwerk event stream before an
`init` event, inspect the `/api/ahp/events` HTTP response before debugging AHP. Native
same-origin `EventSource` requests may omit `Origin`; Planwerk accepts that browser shape
only when Fetch Metadata says `Sec-Fetch-Site: same-origin`. A 403 here means the request
was rejected by the local HTTP guard and never attempted an Agent Host connection.

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
Harness caveat: `node --test` runs modules directly; `@/` aliases, `server-only`,
and TypeScript parameter properties need test support. Existing integration
tests use scoped `node:module` `registerHooks` to resolve aliases and replace
external boundaries with fakes. `lib/ahp/client-bridge.test.ts` exercises the real
event bridge, snapshot reads, explicit sending, and turn resume without touching
a live host. Prefer these fakes over smoke subscriptions when investigating
timestamp/residency side effects. `sdk-runtime-isolation.test.ts` verifies the
direct SDK configuration and health path without launching a runtime.

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
- `lib/ahp/session-details-core.ts`, `lib/ahp/session-details.ts` — default-chat
  final-response/error projection, explicit detail reads, and verified resumable-turn
  recovery. Transcript extraction is independent of whether a changeset exists.
- `lib/ahp/protocol.ts`, `lib/ahp/protocol-rpc.ts`, and `lib/ahp/initialize.ts` —
  protocol negotiation. Every build offers only AHP 1.0.0 and rejects an unoffered
  selection. There is no older-version fallback or newer-version retry.
  Unsupported-version errors preserve both host and client offers.
- `lib/ahp/changeset-review.ts` and `app/api/ahp/sessions/review/route.ts` — the
  official SDK mutation path for host-owned file review bits.
- `lib/ahp/tool-safety.ts` — redacts `toolAuthentication` to a VS Code handoff and validates
  host-provided confirmation options/tool-safety state. Host tool safety is not Planwerk
  card risk and never advances a phase.
- `lib/ahp/chat-facts.ts` — passive lightweight chat catalog projection, writable
  default-chat checks, and live chat/background-work/static-changeset observation.
  Cold sessions stay catalog-only; existing live observers survive idle and
  input-needed states. Chat-scoped files are informational and never replace
  session changeset gate evidence. Hidden/archived/removed chats release observers.
- `lib/ahp/types.ts` — `AHPStatus` bits + `parseAHPStatus`.
- `app/api/ahp/events/route.ts` — SSE bridge + triage entry point. Each connected board
  sends its selected workspace paths as `workspaceScope`; all automation is limited to
  the union of cards visible in those connected tabs **for the same originating AHP
  host**. The optional archive stream never contributes automation scope.
  Card snapshots, bridge connections, heartbeat operations, action broadcasts,
  and reprojection are host-partitioned; disconnecting one tab does not stop another
  subscriber or host. An unfiltered tab intentionally permits all workspaces. A malformed
  supplied scope fails closed, while an omitted
  scope preserves compatibility with older clients. The browser's “hide done” setting
  does not further limit automation because archived cards are already excluded.
  Heartbeat actions also re-project the affected card from `session_cache` plus current
  SQLite gate/review state and emit `cardChanged`; gate completion therefore does not
  wait for an unrelated AHP host event to refresh the board. Asynchronous deterministic
  commands emit `gate-completed` after their `gate_runs` row is finalized, which is the
  refresh signal that clears the evaluating state.
- `lib/orchestrator/{heartbeat,gate-engine,triage,risk-*}.ts` — the autonomous loop.
  A card blocked on Copilot's plan-review input resolves its required `plan->build`
  review gates from `.github/planwerk.yml`. Each configured skill prompt runs in a
  peer chat in the owning AHP session. A peer chat is not a subagent or an
  inherited conversation: plain `createChat` creates a fresh SDK backing with its
  own session-state directory. The current review prompt does not transfer the
  parent's plan bytes or resource reference, so a reviewer can report that no plan
  exists even when the default chat has one. Compare the parent's actual plan
  with the peer's tool calls before diagnosing a missing source plan.
  The exact peer `chat_uri` and `turn_id` are stored in
  `review_runs` against the current `plan:<hash>`, with a linked `gate_runs` row.
  Blocking findings are returned on the **original** AHP input as
  `chat/inputCompleted(response:"accept")` with a selected answer carrying
  `freeformValues`. VS Code maps that to Copilot's
  `{ approved:false, feedback, selectedAction }`, which revises the plan without
  Planwerk declining first or waiting for a second elicitation.   A passing medium/high-risk plan remains pending for human approval by default; inspect
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
(`lib/ahp/session-messenger.ts`) reports `success` only after it reduces
authoritative `SessionState.inputNeeded` actions and confirms the request left
the aggregate
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
the latest YAML-configured `review_runs` rows: `changeset_ref` must match the card's
`planContentHash`; `chat_uri`/`turn_id` identify the exact peer review turn;
`verdict_summary`/`findings_json` contain the gate evidence; and `status` distinguishes
a passing review, blocking findings, and escalation. If no peer chat was created, check
the provider's advertised `multipleChats` capability and the recorded failure.
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
- **Code ref** `source:<encoded-host-revision>` for current runs (legacy rows may contain
  `files:additions:deletions:modifiedAt`, with modifiedAt dropped when normalized).
  Used for `build->review` and `review->ship`. The source revision and enrichment are
  accepted only when they are paired in `session_cache`, and the diff is verified from
  the **session-scoped** changeset (`changeKind:"session"`, isolated per agent) via
  `changeset-enricher.ts`. Current VS Code also derives
  `SessionSummary.changes` from that session changeset, but Planwerk marks counts verified
  only after reading a ready per-file snapshot itself. When `card.changesetVerified` is
  false, the ref is treated as **unknown** (`undefined`) and all revision-bound evidence
  fails closed until a current ref is available.
- **Plan ref** `plan:<hash>` (opaque identity of `plan.md` content, hashed in
  `changeset-enricher.ts` / merged in `client-bridge.ts`). Used for `plan->build` reviews
  (`plan-review` = `/rubber-duck`) so unrelated code churn — or another agent's edits —
  can't re-trigger a passed plan review. Carried on `card.planContentHash`.

Empty/unknown current ref ⇒ **fail closed**. Prior gate and review evidence is not
reused, new evidence is not started without a revision binding, and heartbeat/API/tool
callers block advancement until `gate-revision.ts` can resolve a non-empty current
revision from matching summary + enrichment facts. For a plan gate, verify that both the
run and current card use a `plan:` ref; for code gates, verify a bound `source:` ref.
Pure-logic tests live in `lib/orchestrator/changeset-freshness.test.ts`.

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
