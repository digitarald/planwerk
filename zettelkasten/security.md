# Planwerk security model

Planwerk is a single-user local application. Its default development and
production commands bind Next.js to `127.0.0.1`; it has no account, session, or
multi-user authorization system. Loopback binding is a deployment requirement,
not a substitute for operating-system isolation.

## Human decisions

High-risk CTO actions pause at the Copilot SDK permission boundary. Planwerk
creates a random 256-bit decision capability and binds its digest to:

- the approval row and normalized action digest;
- SDK session and tool-call identity;
- expiry; and
- the current process owner and live in-memory permission waiter.

Only a context-bound SHA-256 digest is stored in SQLite. The raw capability is
handed once over the response stream that is already serving the originating
orchestrator chat turn. It is not returned by the general approval listing,
persisted in Zustand session storage, copied into SDK telemetry, or written to
application logs. Digest comparison uses a fixed-length constant-time compare.

`POST /api/orchestrator/approvals` accepts only the capability and an
approve/reject decision. It rejects client-supplied actors and records the
stable `local-human` actor. The route requires JSON, an exact loopback
Origin/Host match (including port), and same-origin Fetch Metadata when present.
There is no GET mutation. A capability is single-use; expiry, cancellation,
owner loss, waiter loss, process restart, changed action facts, or replay fails
closed. `GET` exposes display metadata only, without approval IDs, action
digests, or decision capabilities.

Every browser-facing local mutation route uses the same validation before
parsing request bodies, opening an AHP/SDK connection, or changing SQLite:
AHP session creation, input, messaging, file review, and archive; orchestrator
review, chat submission/cleanup, and approvals; direct gate checks, execution,
approval, transition, and advancement; and coherence dismissal. The guard
requires a loopback request Host, an exact same-origin `Origin` (including
port), same-origin Fetch Metadata when present, and an `application/json`
media type. This rejects cross-origin and browser-simple `text/plain` requests.

`GET /api/ahp/events` is treated as side-effecting because opening its SSE
stream creates an AHP bridge and starts heartbeat automation. Before reading
`host` or `workspaceScope`, creating a stream, or starting either subsystem, it
applies the same strict loopback Host, exact same-origin Origin, and Fetch
Metadata checks. Legitimate EventSource GET requests do not need a
`Content-Type`; the JSON requirement remains exclusive to POST/DELETE
mutations. An omitted workspace scope therefore cannot turn a cross-origin
request into an unscoped automation subscription.

Direct gate checks, runs, approvals, and advancement resolve the current
changeset revision from source-bound `session_cache` facts; a missing
authoritative revision fails closed, a supplied mismatch is rejected, and
omitted caller revisions cannot make an older gate verdict fresh.

Consumed grants remain bound to the same process owner and its unexpired owner
lease. The final override validates that owner, the exact SDK/tool-call/action
digest, and current facts in the same SQLite transaction as the phase update.
A crash after SDK permission consumption therefore cannot leave authority for a
replacement process.

Risk assessments are versioned by a stable digest of the authoritative session
summary/enrichment, cache timestamp, phase, and phase timestamp. Assessment
results commit only if those facts still match. Missing legacy digests and
stale digests cannot authorize an override.

The SDK turn timeout is bounded but covers the full approval TTL plus a short
execution allowance. Ending or aborting the stream cancels the server waiter
and expires the corresponding client decision item.

## CTO conversation cleanup

The SQLite lease is renewed until asynchronous SDK disconnect or deletion and
the final durable mutation finish. Before deletion, the session binding moves
to an owner-fenced `deleting` quarantine. A timeout leaves that tombstone in
place and retires the exact SDK runtime generation. Disconnect timeouts also
write the tombstone before releasing ownership; no worker may resume the
timed-out conversation or replace the binding
until a later owner reconciles deletion. Final removal compares the expected
session ID, deletion token, and current lease owner, so late completion cannot
clear a replacement. Metadata and invalid-resume cleanup use the same
owner/session fencing after every awaited SDK boundary.

Confirmed AHP mutation results are independent from connection teardown:
shutdown failures are logged for health/reconciliation but never turn a
confirmed session/chat/turn identity into a retryable mutation failure.

## Limitations

- Same-origin checks prevent browser CSRF; they do not authenticate a native
  process running as the same OS user. Such a process can synthesize HTTP
  headers, initiate its own CTO chat turn, or inspect the user's browser/process.
- XSS or a compromised same-origin dependency executes inside the trusted UI
  flow and can observe an in-flight capability.
- SQLite confidentiality and process memory rely on local filesystem and OS
  account permissions.
- Do not bind Planwerk to a LAN/public interface or place it behind a proxy
  without adding authenticated users, TLS, proxy-aware origin policy, and a
  separate authorization model.
