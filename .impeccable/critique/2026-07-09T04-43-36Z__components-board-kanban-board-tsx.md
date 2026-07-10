---
target: board
total_score: 20
p0_count: 0
p1_count: 3
timestamp: 2026-07-09T04-43-36Z
slug: components-board-kanban-board-tsx
---
# Critique — Planwerk Kanban Board

Method: dual-agent (A: assessment-a-design · B: assessment-b-detector) · parent-captured browser evidence (single shared Playwright instance, live board at localhost:3000 connected to a real AHP host, 37 cards)

Target: the kanban board surface (`components/board/*`, `app-shell.tsx`, tokens in `app/globals.css`).

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Status exists, but the states that need a human (failed gate, high risk, over-WIP) read too small to dominate. |
| 2 | Match System / Real World | 3 | SDLC language fits engineers; "Gate" vs "Blocked on 3 gates…" vs icon-only "passed" breaks fluency. |
| 3 | User Control and Freedom | 2 | Thoughtful drag/reconcile + rollback, but no visible undo, bulk actions, or keyboard phase movement. |
| 4 | Consistency and Standards | 2 | One concept (gate state) appears as icon, red pill, verbose text, or omitted label. |
| 5 | Error Prevention | 3 | Gate rollback + manual-override logging is strong; WIP overage is only advisory. |
| 6 | Recognition Rather Than Recall | 2 | Too many icon-only states depend on tooltip memory. |
| 7 | Flexibility and Efficiency | 1 | Enter/Space opens a card, but no shortcuts, bulk ops, dense mode, or "jump to next attention." |
| 8 | Aesthetic and Minimalist Design | 2 | Clean and restrained, but hierarchy is under-ranked and whitespace is too expensive. |
| 9 | Error Recovery | 2 | Some recovery messages, but card-level gate-failure recovery isn't actionable on the card. |
| 10 | Help and Documentation | 1 | Tooltips only; no contextual explanation for gates, overrides, or WIP. |
| **Total** | | **20/40** | **Acceptable — low end. Usable foundation, below bar for an all-day operator surface.** |

## Anti-Patterns Verdict

**Does this look AI-generated? No — not in the marketing-slop sense. But there is real product-slop.**

**LLM assessment:** The surface has credible VS Code-native restraint (good OKLCH light/dark tokens, no gradient/hero/glass clichés). What an engineer fluent in Linear/Raycast/GitHub would pause at: (1) empty PLAN/REVIEW columns collapse into ~60px rotated-label rails, breaking the 5-stage pipeline model; (2) inconsistent gate vocabulary; (3) important states rendered as 9–11px icon soup; (4) demo-board density, not an all-day console.

**Deterministic scan (`detect.mjs`):** CLEAN — 0 findings across `components/board`, `app-shell.tsx`, `title-bar.tsx`. No side-stripe borders, no gradient text, no hardcoded hex/rgb (OKLCH tokens used throughout), no glass cards. This is a genuinely well-built token layer.

Static cross-check surfaced three real deterministic issues the CLI rules don't cover:
- **No `prefers-reduced-motion` coverage** (0 occurrences) against **43 transition/animate usages** across `kanban-card.tsx`, `pending-input-card.tsx`, `kanban-column.tsx`, `card-detail-modal.tsx`, `board-skeleton.tsx`.
- **Overused tiny uppercase tracked labels** (`text-[10px] uppercase tracking-widest`) repeated ~10× in `card-detail-modal.tsx` (lines 523,535,585,629,648,712,726,775,781,803).
- **Non-semantic z-index** — flat `z-50` for all overlays (modal, tooltip, dialog, context-menu); no named scale.

**Visual overlay (parent-captured, in-page detector):** confirmed **flat type hierarchy (9,10,11,12,13,14,16px; 1.8:1 max ratio)** — 9–11px text on an all-day surface; **layout-property animation** (`transition: width / min-width / max-width`) on the collapsing columns; **text-overflow** (an `h2.font-heading` overflowing its box by 134px, a muted paragraph by 204px) corroborating the collapsed-column clipping; single-font (Inter 100%). The overlay's `gradient-text` hits are a **false positive for the board** — grep found 0 `bg-clip-text/background-clip` in board source; it's the onboarding screen's `bg-gradient-to-b`. Its `nested-cards` hits are largely expected (cards inside a card-styled column container), but reinforce that the column chrome reads as a card.

## Overall Impression

A solid, restrained technical foundation that **whispers when it should rank.** The data model correctly separates phase from runtime status, gates are respected with optimistic-move-plus-rollback, and the palette is right for a developer tool. But the board is visually *calm* everywhere — healthy autonomous progress and an urgent high-risk gate failure read at nearly the same weight. For a product whose entire promise is "surface what needs a human," that inverted emphasis is the single biggest opportunity: **make the exceptions dominate and keep the healthy sessions quiet.**

## What's Working

1. **Restrained, correct product palette.** OKLCH VS Code 2026 light/dark tokens, zero hardcoded colors — the detector confirms it (`app/globals.css:52-150`). This is earned familiarity, not strangeness.
2. **Gate integrity is respected in the interaction model.** Optimistic move → server reconciliation → rollback with an audit alert (`kanban-board.tsx:36-172`) is exactly aligned with "gates are external and enforced."
3. **Inline pending-input is directionally right.** The operator can act without the board becoming an IDE (`pending-input-card.tsx`), honoring the "management surface, not an IDE" principle.

## Priority Issues

### [P1] Empty columns collapse the pipeline
- **What:** PLAN and REVIEW, when empty, collapse to ~60px rails with the heading rotated 90° (`kanban-column.tsx:27-68`; layout in `kanban-board.tsx:176-182`). Confirmed visually and by the overlay's text-overflow finding.
- **Why it matters:** The operator loses the canonical `Define → Plan → Build → Review → Ship` map — it reads as "Define → Build → Ship with hidden states." "Empty" should mean *clear*, not *gone*. An empty Review is itself operational information.
- **Fix:** Keep all five columns structurally present at full width; render a compact in-column empty state (title, `0` count, sublabel, drop target) instead of collapsing. Stop animating `width/min-width/max-width` (layout-property animation).
- **Suggested command:** `/impeccable layout`

### [P1] Attention states are under-ranked (the core promise)
- **What:** Human-needed, gate-failed, high-risk, and over-WIP all render as small badges/icons: title-bar attention is a tiny amber number (`title-bar.tsx:40-43`), column attention a 2px pulsing dot (`kanban-column.tsx:69-73`), high risk a 14px shield, failed gate a 9px "Gate" pill, over-WIP an amber `5/3` no louder than a normal count.
- **Why it matters:** This product only wins if the operator instantly finds the exception among 12+ sessions. Right now the system whispers escalation; healthy and urgent look equal.
- **Fix:** Build an explicit attention hierarchy — cluster/sort attention cards first, give `needs-human/error/conflict` stronger card treatments, promote over-WIP to a column-level alert, and add an "Attention" filter/queue that points to the card. Touch `attentionStyles` (`kanban-card.tsx:65-71`), `title-bar.tsx:40-43`, `kanban-column.tsx:59-73`.
- **Suggested command:** `/impeccable bolder` (then `/impeccable colorize` for the semantic state ramp)

### [P1] Gate/status vocabulary is inconsistent
- **What:** Gate state appears four different ways — verbose "Blocked on 3 gates: Lint, Typecheck, Tests", a compact red "Gate" pill, an icon-only green check ("Gates passed"), and a spinner (`kanban-card.tsx:135-150,302-315`; blocker copy in `enrich-card.ts:89-104`). Runtime status and gate status also share one visually flat row.
- **Why it matters:** Engineers will not trust a *quality-gate* surface that can't name gate states consistently. It also blurs the phase-vs-runtime axes the data model works hard to separate.
- **Fix:** Standardize a two-axis grammar, always labeled: `Runtime: Running / Idle / Input / Error` and `Gates: Passed / Failed / Blocked / Evaluating`, with gate names on a consistent secondary line. Fix `GateIndicator` and the status row in `kanban-card.tsx`.
- **Suggested command:** `/impeccable clarify`

### [P2] Density is too low for an all-day cockpit
- **What:** Generous card padding; only ~5 cards fill a tall viewport (`kanban-card.tsx:272`, `kanban-board.tsx:178`). Flat 9–16px type ramp gives nothing to anchor scanning.
- **Why it matters:** Power users directing 12+ sessions need a cockpit, not a presentation board; low density forces scrolling before the operator has seen the state.
- **Fix:** Add a compact/dense default or density toggle — tighter padding, one-line title+status, metadata revealed on hover/focus — and strengthen the type hierarchy (fewer sizes, clearer primary vs meta). Consider Geist Mono (already loaded but unused) for diff stats/IDs.
- **Suggested command:** `/impeccable layout` (with `/impeccable typeset` for the type ramp)

### [P2] Power-user controls are invisible
- **What:** Beyond Enter/Space opening a card (`kanban-card.tsx:262-269`), there are no visible shortcuts, no bulk actions on the 5 Build or 30 done sessions, no keyboard phase movement; workspace filters expose 6 choices in the header with no command/search shortcut (`title-bar.tsx:131-190`).
- **Why it matters:** "Alex the power user" judges a developer tool in ~30 seconds; a keyboard-first, VS Code-native promise isn't visible.
- **Fix:** Surface keyboard hints, add command-palette actions for board ops, multi-select/bulk archive, and "jump to next attention." A command palette scaffold already exists (`command-palette.tsx`).
- **Suggested command:** `/impeccable harden` (efficiency + states) 

## Persona Red Flags

**Alex (impatient power user):** No visible keyboard model beyond open-card; no bulk ops for 5 Build / 30 done cards; low density forces early scrolling; 6 workspace chips with no palette shortcut; collapsed PLAN/REVIEW feel clever rather than fast.

**Operator mid-incident (a session failed a security/gate review):** high-risk + failed-gate does not dominate — a tiny red shield plus a 9px "Gate" pill; no incident queue (the attention count says "something needs you" but doesn't point to the card); verbose blocker text can truncate, hiding *which* gates failed (`kanban-card.tsx:307-315`); over-WIP `5/3` is too quiet; recovery requires opening the detail modal instead of surfacing the next action on the card.

## Minor Observations

- `BoardSkeleton` shows equal ~220px columns while real empty columns collapse — a loading→loaded layout jump (`board-skeleton.tsx:20-31`).
- `stale` attention is expressed as reduced opacity (`kanban-card.tsx:65-71`), making a *problem* look disabled / less important.
- Motion glows exist without a `prefers-reduced-motion` fallback (`app/globals.css:197-222`) — deterministically confirmed (0 coverage vs 43 motion usages).
- Rail + collapsed columns create several "thin strips" at once (`app-shell.tsx:30-47`).
- "Show 30 done sessions" may read as a count button, not a visibility toggle (`title-bar.tsx:60-76`).
- Overused `text-[10px] uppercase tracking-widest` section headers in the detail modal (~10 instances).

## Questions to Consider

1. What if Planwerk's default view were an **exception queue overlaid on a phase map**, not a pure kanban?
2. What changes if every card had two explicit lanes — **Lifecycle/Gates** and **Runtime/Agent** — instead of one flat status row?
3. Should an empty phase ever shrink, or is "nothing in Review" itself valuable operational information worth full-width presence?
