# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Software engineers and engineering leads who direct multiple concurrent AI agent
sessions. Their context: at a desk, alongside their IDE, watching a board for
most of the workday rather than opening it occasionally. Their job-to-be-done is
to *direct* agent work — start tasks, unblock stuck sessions, review what gates
have already validated, and ship — instead of babysitting sessions one at a
time. They are power users who live in developer tooling; speed, keyboard
control, and dense-but-legible information matter more than hand-holding.

## Product Purpose

**Run a team of coding agents without babysitting every session.**

Planwerk brings their work into one inbox and board, so you can see what needs
a decision, what's blocked, and what's ready to ship. Independent reviews check
the work; you decide how much the coordinator can do.

Success is a shift in the developer's job: from *doing the work* to *directing
the work*, without losing accountability. Writing got cheap; understanding
didn't — Planwerk makes sure a human still owns what ships.

## Positioning

Planwerk is a management surface, not another place to write code. It combines
cross-session oversight with independent quality gates and explicitly granted
coordinator authority. The operator can direct concurrent work without treating
an agent's own confidence as verification.

## Operating Context

Used locally alongside the developer's IDE, across multiple concurrent coding
sessions. The inbox ranks human handoffs; the board tracks
`Define → Plan → Build → Review → Ship`. Opening an item is not the same as
resolving it.

The local web app and macOS desktop wrapper share the same management interface.
The desktop app retains its connection when its window is hidden; hiding it
does not grant more authority.

AHP is the session integration boundary. VS Code with Copilot is the first
tested host/provider combination, not the product's identity. Other AHP hosts
are not automatically supported just because they speak the protocol.
GitHub Issues, Projects, and pull-request integration is product direction,
not a claim of complete shipped workflow integration.

## Capabilities and Constraints

- **Authority:** Observe is the default. Verify permits checks and independent
  report-only reviews. Coordinate may interact with sessions and advance phases
  after gates pass. Per-session overrides are explicit and audited.
- **State:** runtime status and SDLC phase are separate. A running/idle change
  never substitutes for a gated phase transition.
- **Evidence:** captured facts, source freshness, and review approval are
  separate. Unavailable or changing evidence stays unverified. Refreshing
  evidence can restore a session and change its activity timestamp.
- **Compatibility:** features depend on what the host/provider actually
  supports. Copilot-specific artifact lookup and the Copilot SDK-powered
  coordinator are implementation dependencies, not universal AHP features.
- **Execution:** deterministic checks currently need a local working directory.
  Remote and multi-directory execution need explicit support; protocol
  compatibility alone is not sufficient.
- **Deployment:** a local, long-lived Node.js application with persistent SQLite
  state and AHP connections, not a serverless service. The macOS wrapper bundles
  the backend. Local desktop builds are unsigned and not notarized.
- **Boundaries:** no code editor or terminal-as-primary-surface in the UI.
  Broad host support, remote execution, public distribution, and complete
  GitHub workflow integration remain open product work.

## Brand Personality

Fast · Powerful · Technical. VS Code-native and engineering-grade — this looks
and feels like part of a developer's environment, not a marketing site bolted
onto a tool. Voice is direct, terse, and unhyped: state the fact, surface the
blocker, log the decision. Confident because the system is accountable, not
because it's loud. No delight-for-delight's-sake; the delight is in speed,
precision, and never making the operator hunt for what changed.

## Anti-references

- **The heavy enterprise dashboard.** Dense gray tables, uniform rows, no visual
  hierarchy, everything the same weight so nothing reads as important. Planwerk
  is dense but *ranked* — attention is designed, not left to the reader.
- **The generic AI-startup landing aesthetic.** Hero-metric templates,
  glassmorphism, gradient text, tracked-uppercase eyebrows on every section.
  Planwerk is a working surface, not a pitch.
- **A full IDE.** No code editing, diffs-as-primary-surface, or terminal-in-the-UI.
  Show progress, decisions, and blockers — never the code itself.

## Design Principles

- **Management surface, not an IDE.** Show progress, decisions, and blockers. If
  a screen tempts you to render code or an editor, it's the wrong screen.
- **Phase is not runtime status.** SDLC phase (persisted, gated) and AHP runtime
  status (`idle` / `running` / `input-needed` / `error`) are different axes and
  must stay visually distinct. Never let a running indicator read as a column
  move, or vice versa.
- **Attention over noise.** The inbox is a durable human-handoff queue, not a
  notification feed. It separates unread from unresolved and uses a
  revision-bound Chief of Staff pass to author the most useful framing for each
  handoff: outcome, decision, risk, unblocker, recommendation, or no-action
  update. The note is free-form rather than a filled template; only its
  attention level and executable controls are structured. Source facts remain
  available on demand, and a clearly identified source-note fallback is used
  when synthesis is unavailable. The board remains the progress map; healthy
  autonomous work recedes in both.
- **Autonomy is granted, accountability is constant.** The coordinator observes by
  default; verification and session-changing authority are explicit operator choices.
  Every grant and autonomous action is legible and auditable. Trust comes from seeing
  the boundary, the reason, and the result rather than hiding the machinery.
- **Native to the developer's environment.** Fast, keyboard-first, VS Code-fluent.
  It should feel like the operator never left their tooling.

## Evidence on Hand

- Working inbox, board, coordinator, gate, evidence-refresh and ownership-recovery
  implementations in [app](app/), [components](components/), and [lib](lib/).
- Product intent and architecture in [zettelkasten/vision.md](zettelkasten/vision.md)
  and [zettelkasten/architecture-and-design.md](zettelkasten/architecture-and-design.md).
- macOS packaging, lifecycle tests and documented distribution limits in
  [desktop/README.md](desktop/README.md).
- Existing light/dark logo assets in [public](public/).
- Automated regression tests are engineering evidence, not customer outcomes,
  production latency guarantees, or independent product validation. Do not
  invent customer names, testimonials, adoption figures, or performance claims.

## Accessibility & Inclusion

No formal WCAG conformance target; accessibility is handled best-effort. Because
this is an all-day operator surface, hold these pragmatic baselines regardless:
readable text contrast (don't ship muted-gray body text that's hard to scan),
keyboard operability for primary board actions, visible focus, and honoring
`prefers-reduced-motion` on any animation.
