# Product

## Register

product

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

Planwerk is the management surface for the agentic SDLC. Its inbox ranks the
decisions, reviews, and completed work that deserve a human next; its board shows
each AI agent session flowing through `Define → Plan → Build → Review → Ship`. External,
system-enforced quality gates block every phase transition, and a persistent
coordinator works at an operator-selected authority level: Observe labels risk
and surfaces blockers, Verify adds checks and independent reviews, and Coordinate
may interact with sessions and advance gated work. Observe is the board default,
with explicit per-session overrides. It manages the AI execution layer between "task defined" and
"PR merged," integrating with GitHub Issues, Projects, and PRs rather than
replacing them.

Success is a shift in the developer's job: from *doing the work* to *directing
the work*, without losing accountability. Writing got cheap; understanding
didn't — Planwerk makes sure a human still owns what ships.

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

## Accessibility & Inclusion

No formal WCAG conformance target; accessibility is handled best-effort. Because
this is an all-day operator surface, hold these pragmatic baselines regardless:
readable text contrast (don't ship muted-gray body text that's hard to scan),
keyboard operability for primary board actions, visible focus, and honoring
`prefers-reduced-motion` on any animation.
