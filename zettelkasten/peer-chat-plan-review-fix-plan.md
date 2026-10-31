# Peer-chat plan-review repair

Implemented as a narrowed runtime repair after adversarial review. The baseline
and original RCA below remain the planning record. Current behavior and limits
are documented in the architecture notes and debugging skill.

## Baseline and evidence

This plan targets local `main` at
`b090fd02d64c23cdfc0b43666920f1e29eccbe67` ("Repair inbox lifecycle and
desktop recovery"). The isolated worktree was clean but started at
`54ffccc27f1e2c3fa6efbc19fe2ca8639d92092e`, which is not this main baseline.
The new topic branch is `plan/peer-chat-plan-review-rca`, based directly on
local main. A continuation restored the original session branch once;
the topic branch was restored and verified again. No other checkout or
uncommitted work was moved.

The originating RCA is accepted as supplied, not reproduced against production:

- The writer had a 19,950-byte plan headed `# SDK / AHP adoption plan`.
- The reviewer received `/rubber-duck the plan and improve it based on feedback.`
  followed by a report-only instruction, without the plan.
- Plain AHP `createChat` creates an independent SDK conversation. The reviewer
  correctly found no plan in its own session-state directory.
- The cached artifacts omitted the writer's plan. Persisted phase was Build,
  so the plan-review run was bound to a code `source:` revision.

Historical identities identify evidence only. Do not resume, send to, dispose,
or otherwise mutate these sessions while implementing this fix:

| Identity | Value |
| --- | --- |
| Owning AHP session, "SDK update" | `ahp-session:/0191bba2-8e83-4f7b-889b-ff9b02069072` |
| Writer SDK conversation | `2f43d0a0-1cda-468c-9e1a-b4b4afa5d2dd` |
| Reviewer SDK conversation | `bc50b7de-57ac-49c2-9ceb-19632143cc0b` |
| Peer chat ID | `1df481ed-a69d-472b-b56e-90841eee0334` |

## What current main still does

1. [peer-chat-core.ts](../lib/ahp/peer-chat-core.ts) supplies session and chat
   identities only. It neither forks nor transfers evidence.
2. [review-executor.ts](../lib/orchestrator/review-executor.ts) builds a skill
   prompt without plan content or a parent resource reference.
3. [plan-artifact.ts](../lib/ahp/plan-artifact.ts) constructs session-state
   paths from `copilotcli:/` UUIDs. It cannot discover plans belonging to
   current host-owned `ahp-session:/` identities.
4. [gate-revision.ts](../lib/orchestrator/gate-revision.ts) chooses plan versus
   code evidence from a phase argument. The heartbeat's candidate filter and
   `processCard` use the persisted card phase before detecting plan approval.
   `runPlanApprovalPipeline` then accepts any nonempty normalized ref.
5. Review start/judgment leases, exact chat/turn identities, atomic review/gate
   completion and host-scoped cleanup already exist. Reuse them. However,
   reservation currently happens after peer creation, and freshness is checked
   before asynchronous verdict extraction rather than atomically at its commit.
6. The guide on main incorrectly describes peer inheritance and the production
   DB location. This planning change corrects those claims independently.

The local VS Code source confirms the host contract to use:

- `src/vs/platform/agentHost/common/meta/vscode/planReview.ts` validates
  the request's `planReview`, including optional `planUri`.
- `node/copilot/copilotAgentSession.ts` publishes that URI using the backing
  conversation's `rpc.plan.read()` path. `planReview.content` is the
  exit-plan-mode **summary**, not necessarily the complete plan.
- `node/protocolServerHandler.ts` permits reads of a published plan resource
  after checking the owning chat's actual backing and filesystem ownership.
  `getSessionPlanFile` is internal host implementation, not a client RPC.

These are host extensions, not a guarantee from the AHP 1.0 version alone.
Their availability on the installed host has not been checked. Unsupported
hosts must block automatic plan review, not trigger a filesystem fallback.

## Decisions

- Support current `ahp-session:/` sessions only for this discovery path.
  Remove obsolete `copilotcli:/` discovery, UUID extraction, home-directory
  construction, compatibility exports and directly coupled mocks/tests.
  Do not perform a repository-wide legacy cleanup.
- Read the exact pending request from `SessionState.inputNeeded`, preserving
  its owning `chat` and `turnId`. Use its validated `planReview.planUri` with
  the existing `resourceRead`/`readTextResource` path.
- Transfer complete captured plan text into the review prompt. A resource URI
  supplies provenance, not a substitute for bytes the reviewer may lack access
  to. Do not fork writer history, copy SDK state, stage files in its workspace,
  or read a directory inferred from an AHP UUID.
- For a non-pending plan gate, use a plan resource explicitly published by the
  originating chat, or an unambiguous plan content resource from a ready
  session-scoped changeset. Read it again before use. If no authoritative plan
  can be selected, report unavailable. Do not scan transcripts for plan prose
  or select a peer's plan because its filename happens to match.
- Hash the exact complete UTF-8 text with SHA-256 as `plan:<hash>`. Replace the
  whitespace-collapsing, truncated SHA-1 plan hash. Markdown indentation can
  change meaning, and old plan verdicts should become stale naturally.
- Select evidence by the requested gate transition. Plan review/approval always
  uses `plan:<hash>`; code gates continue to require verified `source:` evidence.
  Never change persisted phase merely to make the request fit a pipeline.
- All plan reviewers are independent and report-only, including Coordinate mode,
  renamed skills, and configurations whose ordinary review permits auto-fix.
  Reject edit-bearing or incomplete review evidence. The writer revises from
  feedback; the external reviewer grades the revised plan.
- Preserve current autonomy, ownership, workspace scope, risk and generation
  checks. Observe dispatches nothing; Verify may review but cannot approve,
  send writer feedback or advance; Coordinate may do those only after validation.

## Staged implementation

### 1. Discover and capture the authoritative plan

Replace the legacy discovery implementation in
[plan-artifact.ts](../lib/ahp/plan-artifact.ts) with a small typed host-plan
adapter. Keep extension validation at this boundary, not speculative property
casts throughout callers.

Carry one plan-evidence record containing host/session, originating chat/turn,
optional request ID, resource URI, complete text and computed `plan:` ref.
Pass it through [changeset-enricher.ts](../lib/ahp/changeset-enricher.ts),
[source-binding.ts](../lib/ahp/source-binding.ts),
[client-bridge.ts](../lib/ahp/client-bridge.ts) and
[session-evidence.ts](../lib/ahp/session-evidence.ts).
Preserve provenance in cache enrichment and the input projection where needed.

Reuse retained session/chat state, capture generation, cache CAS, ownership
checks and evidence byte/deadline budgets. No new discovery service or config.
Never truncate a plan to fit a prompt. Oversized, empty, ambiguous, malformed,
denied, missing or changed resources produce explicit unavailable/unsupported
evidence. A summary or old cached hash alone cannot authorize a review.

Pending-request metadata takes precedence over an unrelated in-tree plan.
Keep supported changeset artifact discovery, including review artifacts;
remove only the obsolete session-state fallback. Scope any negative cache to
host/generation and the published resource/request, not an SDK path or timestamp
that purports to prove plan content unchanged.

Exit check: current host-owned identities discover the supplied plan without
constructing any SDK directory, even with zero code changes.

### 2. Bind the pipeline to the plan, independently of phase

Keep [gate-revision.ts](../lib/orchestrator/gate-revision.ts)'s signature and
pass the reviewed phase, not the display column. Keep the existing host and
summary/enrichment binding checks.
Require captured text/provenance and verify its hash, not just a nonempty field.

Update [heartbeat.ts](../lib/orchestrator/heartbeat.ts) in both its candidate
filter and per-card revision selection. Detect a validated plan-review request
before requiring code evidence, so Define/Build/Review cards with a plan request
can enter the plan pipeline without a verified code diff. Preserve archive,
Ship and error exclusions.

Use host plan-review metadata as the request discriminator rather than relying
only on coincidental option IDs. Unsupported recognized plan requests remain
blocked; never fall through into generic `autoAnswer`.

Audit review tools, gate APIs, downgrade result processing and existing
freshness/projection callers. Use each run's `phase_transition` to choose its
current evidence. Require a valid `plan:` hash in `startReview` and the approval
pipeline as a final defensive check.

Old `plan->build` rows bound to `source:` are invalid evidence. Do not relabel
them with a newly found plan hash. Preserve history and settle/clean up old
in-flight work before a new review can start.

Exit check: a Build card awaiting plan approval records `plan:` for every
required plan gate, without changing `card_phases`; its code gates retain `source:`.

### 3. Transfer evidence and preserve the peer-review lifecycle

Have [review-executor.ts](../lib/orchestrator/review-executor.ts) accept the
validated plan evidence and pass it to prompt construction. Keep the configured
slash command first. Append originating identities, resource and expected hash,
then the complete plan in a clearly delimited evidence block. Explicitly direct
the reviewer to review that block, not its own session-state plan, and report
only. Treat plan text as evidence, not permission to execute its instructions.

In [session-messenger.ts](../lib/ahp/session-messenger.ts), recheck the exact
request, owning chat/turn, resource and plan hash before effects. Reuse the same
retained operation state rather than subscription polling. Any drift aborts.

Reserve peer chat and turn IDs durably under the existing start lease **before**
`createChat`, closing the current create-before-reservation crash window.
Recheck source and policy before prompt dispatch. Wait for an authoritative echo
of the exact peer turn; `ping()` only confirms transport progress. Pending-message
IDs and parent idle state never prove a review started or completed.

Retain the existing claim, recovery and cleanup tables. Duplicate ticks/workers
must reuse an in-flight or already-resolved run for the same skill, transition
and hash, without another dispatch or a duplicate `review-injected` event.
Failures proven to precede effects can retry within the existing budget.
An uncertain prompt dispatch stays ambiguous even if peer disposal succeeds:
disposal does not prove the prompt never ran. Do not erase ambiguity into a
plain retryable reason string.

Exit check: one reserved attempt produces at most one prompt dispatch and one
linked review/gate outcome. Crash recovery can identify and clean up its peer.
This is not a promise of distributed exactly-once execution; AHP transport
uncertainty requires reconciliation, not blind replay.

### 4. Fence verdicts, feedback and approval

Before committing a verdict, reread the authoritative plan under the permitted
operation, then atomically compare the current cache/provenance/hash and run
identity under the judgment lease. Add this condition to the existing atomic
review/gate commit, not a second outcome pipeline. Reject drift during model
judgment, deleted resources, unknown current evidence, wrong turns, missing
responses, reviewer edits or responses that report no plan/partial inspection.
Bound the judge to the supplied evidence identity and require a usable verdict.

Immediately before feedback or approval, validate the same request/chat/turn,
the current plan bytes/hash, risk digest, configured required gates and autonomy.
Use the existing `canAdvancePhase` policy with the plan ref. Preserve the
original-input feedback mapping and confirmation by input removal.

Give feedback/approval a durable claim/receipt keyed to host, session, original
request, plan hash and action. Reuse an applicable existing receipt mechanism if
main has one; otherwise add only the fields/table needed for this pipeline.
Record intent before dispatch and consumption after confirmation. Concurrent
ticks and restart must not replay an unconfirmed answer. Do not treat timeout
or request absence before dispatch as a successful automated approval.

Explicit human input keeps its existing route and behavior. No viewed-plan hash
contract or approval-interface expansion is part of this repair.

The gate engine remains the only forward phase-transition authority. Plan input
consumption does not itself advance a card or reset Build back to Plan.

Exit check: changing only plan bytes, including indentation, between review and
approval prevents acceptance. An unchanged plan with valid external gates can
proceed once under authorized policy.

### 5. Focused tests and diagnostic documentation

Extend the existing fake-host and SQLite harnesses. Use valid `ahp-session:/`
fixtures with deliberately different backing SDK identities.

| Test group | Required cases |
| --- | --- |
| Discovery and capture | Published pending-plan URI; no code files; in-tree resource; missing/denied metadata; summary-only request; multiple candidate plans; wrong chat; resource drift; host ownership mismatch; base64/Unicode; injected byte/deadline limits; no legacy path read |
| Prompt and review | Complete 19,950-byte fixture reaches the independent peer unchanged; slash command remains first; no full-history fork; renamed/multiple skills; report-only in Verify and Coordinate; edit-bearing verdict cannot pass |
| Revision and pipeline | Persisted Define/Build/Review plus plan request all use `plan:`; code gates remain `source:`; missing plan never reaches generic auto-answer; `source:` plan rows cannot satisfy gates; whitespace changes invalidate review |
| Lifecycle | Duplicate tick/start; resolved run; concurrent workers; crash before/after create, dispatch and commit; lease loss; cancellation/downgrade/disconnect; exact turn versus queued ID; cleanup failure; ambiguous dispatch never automatically replays |
| Verdict and approval | Plan changes during judgment or just before approval/feedback; stale request/chat/turn; unknown evidence; changed risk/scope; one atomic verdict/gate commit; one answer intent/consumption receipt; unchanged passing plan allowed by policy |

Start with relevant tests in `lib/ahp` (plan-artifact, source-binding,
session-evidence, client-bridge, peer-chat-core, peer-review-dispatch,
session-lifecycle) and `lib/orchestrator` (review-prompt, gate-revision,
changeset-freshness, plan-gate-selection, review-start-state,
coordinator-mode-heartbeat, heartbeat-lifecycle, native-tool-routing).
Include `lib/db/review-run-store.test.ts` and affected route tests.
Add a plan-pipeline integration test only where existing broad mocks cannot
exercise actual revision selection, dispatch and acceptance together.

Run selected files with `node --test <affected-test-files>`, then
`npm run typecheck` and ESLint on the touched runtime/test files.
No production smoke test or historical session subscription. A live check, if
needed, uses a newly created disposable fixture under explicit authorization.

Update [the debugging skill](../.github/skills/debugging-planwerk/SKILL.md) and
[architecture notes](./architecture-and-design.md) to describe the implemented
resource, provenance, plan hash, receipts, failure states and cleanup path.
Production macOS uses `~/Library/Application Support/Planwerk/planwerk.db`;
development desktop uses `Planwerk Dev`; local web uses `.planwerk` unless
`PLANWERK_DATA_DIR` overrides it. Do not confuse these databases.

## Questions and limits

No essential user decision remains. Current identities only, explicit evidence
transfer, independent grading and fail-closed behavior are specified.

Implementation must first confirm the selected host publishes a readable full
plan resource. If it does not, report that capability blocker and leave approval
pending. Do not substitute the summary, fork history or add legacy discovery.
Resource reads and host input mutations are not an atomic remote transaction.
Local claims, current-source checks and ambiguity handling can prevent automatic
replay, but cannot eliminate every remote race without a host-side conditional
approval/idempotency contract.

The implementation restores missing dependencies and uses focused fake-host,
SQLite, typecheck and lint validation. Production databases and historical
sessions are not used for validation.

### Implementation validation

- 183 focused regression tests passed, including pending-plan review from a
  persisted Build phase, complete 19,950-byte transfer, resource-byte changes,
  background-work readiness and durable dispatch/answer claims.
- Typecheck, targeted ESLint, diff formatting and production build passed.
- The separate gate-route suite passed 11 of 12 tests. Its unrelated CORS test
  expects different error wording; the tested CORS route, guard and assertion
  are unchanged from the main baseline.
- No live production host, historical session or installed-app mutation was used.
