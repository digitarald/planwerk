# Phase 2: locate and eliminate UI hangs

## Implementation and measured status

The instrumentation below is implemented. A production Chromium replay verified
startup/board milestones, trusted input probes, bounded numeric batches, and a
deliberate 200 ms block inside JSON parsing. The stall/observer records correctly
included the injected `sse.parse` span. This is browser evidence, not native
WebKit certification or proof that the reported macOS startup hangs are fixed.

An explicit React-profiling build exposed avoidable whole-board update work.
Memoizing unchanged cards reduced render time in the same synthetic workload:

| Single-run scenario | Before card memoization | After |
| --- | --- | --- |
| 1,000 cards, 200 updates: React render | 145.5 ms | 32.2 ms |
| Same burst: Chromium long task | 317 ms | 158 ms |
| Same burst: measured application work | 88.7 ms | 90.3 ms |
| Initial 1,000 cards: longest observer entry | 479.6 ms | 494.5 ms |

Memoization improves updates, not initial mounting. Initial React rendering was
178.3 ms before and 189.7 ms after (plus subsequent renders); mounting remains a
hotspot. These are individual observations, not p50/p95 or an overhead benchmark.
The burst still exceeds the proposed 100 ms task budget. Navigation-through-test
time includes deliberate fixture waits and metric delivery; it is not startup
duration.

Default builds retain timing/span probes but omit React render profiling.
`PLANWERK_PROFILE=1 npm run native:build` enables that diagnostic build;
`PLANWERK_PERFORMANCE=0` at launch disables browser monitoring for comparisons.
See the [desktop diagnostics guide](../desktop/README.md#ui-performance) for
record interpretation, retention, and privacy.

Still required:

- Replay cold/warm launch and reconnect on the actual packaged WebKit view.
- Capture a native CPU timeline for slow initial mounting and reported hangs.
- Collect the 20-run cold/warm baseline and enabled/disabled overhead comparison.
- Ratify and enforce budgets after those measurements. No smoothness or
  less-than-2% overhead claim has been established.

## Baseline from phase 1

Desktop diagnostics now correlate native, backend, WebKit errors, and host logs by
launch ID. `backend.ready` measures server readiness; `webview.dom-ready` measures
navigation-to-DOM readiness and first-load native startup duration. The backend
samples event-loop delay/utilization and memory every 30 seconds.

Those alone do not measure React hydration, a usable board, input latency, or
browser main-thread hangs. Phase two adds attribution before choosing fixes.

## 1. Record one startup timeline

Install early browser instrumentation with Next.js `instrumentation-client.ts`
and the native preload. Use monotonic `performance.now()` times and include a
document/navigation ID, launch ID, milestone name, duration, and counts.
Exclude workspace paths, card titles, messages, and full URLs.

Record these distinct milestones:

1. Native launch and backend spawn/readiness.
2. WebKit navigation: response start, DOM content loaded, first available paint.
3. Client instrumentation start and first React commit.
4. Persisted-store hydration, connection start, and first SSE init received.
5. Initial card JSON parsing, store application, and board commit.
6. First board paint opportunity after that commit, followed by a trusted input
   probe. Double-rAF is not proof of paint or interactive readiness.

Correlate to backend catalog/cache reads and first SSE init production. Keep
connection readiness separate from board readiness: the app must remain
responsive when VS Code is disconnected or its host is slow.

Ground the initial probes in:

- [LiveSessionProvider](../components/live-session-provider.tsx) and
  [useLiveSessions](../lib/hooks/use-live-sessions.ts): connect, parse, init,
  event batches, and reconnects.
- [board-store](../lib/store/board-store.ts): session-storage hydration,
  `setCards`, updates, and serialization.
- [AppShell](../components/app-shell.tsx) and
  [policy hydration](../lib/hooks/use-coordinator-policy-hydration.ts):
  startup work competing with board readiness.
- [KanbanBoard](../components/board/kanban-board.tsx): initial/repeated commits
  and interaction responsiveness.
- [AHP event stream](../app/api/ahp/events/route.ts) and
  [client bridge](../lib/ahp/client-bridge.ts): initial server projection versus
  network/host wait.

## 2. Detect visible main-thread stalls

- Feature-detect `PerformanceObserver` entry types. Collect long tasks (50 ms+),
  long animation frames, and event timing where the actual macOS WebKit supports
  them. Record unsupported capabilities, never silently equate them with zero.
- Provide a lightweight timer-lag fallback for WebKit: 250 ms sampling and a
  100 ms excess-delay threshold. Shorter jank can be missed; WebKit does not
  provide the Chromium long-task/long-animation-frame evidence above.
- Suspend monitoring when hidden; reset the baseline on visibility changes,
  wake from sleep, and window restore. Do not classify normal throttling or
  sleeping as UI hangs.
- Treat gaps over five seconds or clock discontinuities as sampling gaps, not
  definitive hangs. A real multi-second hang can also land in this category.
- Maintain a small in-memory ring buffer of named application spans. On a
  100 ms+ visible stall, persist the overlapping spans, event/card counts, and
  recent milestones. Summarize lesser stalls periodically.
- Keep transport batches and diagnostic buffers bounded. Report dropped samples.
  Use a separate performance allowance so routine metrics cannot crowd out errors.

## 3. Attribute expensive application work

Instrument JSON parse, initial/repeated store updates, persistence writes, board
commits, and event bursts with explicit begin/end spans. Use React Profiler only
in an intentional profiling build; ordinary production builds do not provide
the same profiling guarantees. Keep default instrumentation low-overhead.

On a repeatable hang, use the real WebKit inspector's CPU timeline to resolve
unknown synchronous work. Overlapping spans identify suspects, not causation.
Do not claim a root cause from a timer gap alone.

Check for event storms, expensive serialization, avoidable whole-board renders,
and synchronous filesystem/logging overhead, but change only measured hotspots.
Preserve authoritative card phases, gate decisions, automation scope, and
runtime status while optimizing.

## 4. Reproduce, then set and enforce budgets

Run packaged macOS builds, not only a development browser:

| Scenario | Measurements |
| --- | --- |
| Cold launch with empty stores | Native-to-interactive milestones |
| Warm launch with saved view and large host catalog | Preference hydration, SSE initialization, board commit |
| 100 / 500 / 1,000 synthetic sessions | Parsing, projection, render scaling |
| Host reconnect and burst of card updates | Event batches, repeated commits, input latency |
| Slow/unavailable host | Local responsiveness independent of host readiness |
| Hide/restore and sleep/wake | No false stall reports |
| Log rotation and diagnostics export | Instrumentation/export do not create visible hangs |

For a documented reference Mac, collect at least 20 cold and 20 warm runs;
report p50/p95, maximum visible stall, and scenario/card count. Start with these
proposed budgets, then ratify them against the baseline:

- No reproducible app-owned visible main-thread task over 100 ms.
- p95 input-to-next-frame under 100 ms in the reference interaction scenarios;
  verify actual paint with native tooling before claiming an INP result.
- p95 app-owned initial board work under 500 ms for 100 synthetic sessions,
  excluding backend launch and external host/network wait.
- Less than 2% runtime overhead with default instrumentation enabled versus
  disabled in the same replay workload.

Report native launch/OS work and external host wait separately, not
hidden inside an averaged "startup" metric. Unsupported WebKit metrics remain
explicitly unsupported; fallback probes and manual traces supply the evidence.

## Completion evidence

Tests cover supported/unsupported observers, visible stalls, hidden/sleep resets,
bounded buffering, attribution payloads, and disabled monitoring cleanup.
Integration fixtures reproduce a deliberately blocked main thread and a burst
of updates; diagnostics must identify the injected span and measurable delay.

Deliver a local startup/stall report, the worst measured hotspot, a narrowly
scoped fix, and before/after measurements under the same workload. A cleaner
timeline alone does not certify a smooth experience.
