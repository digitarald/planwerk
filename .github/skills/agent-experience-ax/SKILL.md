---
name: agent-experience-ax
description: "Applies John Maeda's Agent Experience (AX) design principles to interfaces where an AI agent does the work and a human judges it. Use when designing or building any AI-assisted or agentic UI (chat + canvas, copilots, dashboards over autonomous work, generative UI, review/approval surfaces) and the open questions are what to show, what to trust, and how users verify, steer, and override outcomes. Grounded in Don Norman's Gulf of Execution and Gulf of Evaluation."
---

# Agent Experience (AX) Design Principles

A reusable lens for designing interfaces in the agentic era. When an agent does the
work, design stops being about *operating* software and becomes about *judging* its
output. Apply these principles to any UI where an AI produces results a human must
trust, verify, or steer.

**Use this for** design decisions on AI-facing surfaces: deciding what to show, how to
make agent output inspectable and trustworthy, and how users verify, steer, or override.
**Not for** purely deterministic UI with no AI in the loop, or low-level implementation
mechanics. This is a high-level judgment lens, not a step-by-step procedure.

## The core reframe

**UX designed the cockpit. AX designs the window.**
- UX = learning to operate the controls ("how do I work this thing?").
- AX = expressing intent and judging the result ("what do I want, and did I get it?").

Don Norman's two gulfs explain where the work moved:
- **Gulf of Execution** ("Can I do the thing?") **collapses toward zero** — the agent
  acts; the user just asks.
- **Gulf of Evaluation** ("Can I tell whether the thing got done right?") **swings wide
  open** — this is now the hard part, and it is where your craft belongs.

> The screen doesn't disappear in agentic products. It changes jobs — from the surface
> you push and drag, to the surface you read to decide whether to trust what just
> happened.

## The one heuristic to keep on the wall

> **For every element you add, ask: which gulf does this serve — and does it shrink the
> Gulf of Evaluation?**

- Execution-side affordances (buttons that operate machinery) should be **minimal, fast,
  and forgettable** — let the user "teleport to the goal."
- Evaluation-side affordances (inspect, compare, explain, verify, steer, override) are
  **the product**. Spend the design budget here.

## Principles

1. **Design the judgment surface, not a status feed.** Make it answer, at a glance,
   "what needs my attention and decision right now?" Surface what must be *understood*,
   not just approved.

2. **Two hands: pair intent with a canvas.** Chat alone is one hand tied behind your
   back — great for asking, useless for verifying. Pair the conversation (say what you
   want) with a persistent, inspectable canvas (see whether you got it). One hand per
   gulf.

3. **Make outcomes inspectable and explainable.** Don't just show *that* the agent did
   something — show *what* it did, *why*, against what inputs, and *how to check it*.
   Visibility of system status is the first usability heuristic and the literal antidote
   to the Gulf of Evaluation.

4. **Never let the surface lie or overclaim.** A self-contradicting state, a stale result
   shown as fresh, or "checking…" when nothing is checking are trust-breaking bugs —
   treat them as severity-one, not cosmetic. Show freshness/staleness honestly; an
   earned "verified" beats a confident-looking guess.

5. **Build trust scaffolding for correction and oversight.** Make it easy to *edit,
   refine, redirect, and override* — with an audit trail. Real steering, not just
   accept/reject. Avoid the "machine operator" trap where the human is accountable for
   outcomes they can't actually influence.

6. **Match scrutiny to stakes (risk-proportional judgment).** Human attention for
   evaluation is the scarce resource now. Trivial, low-cost actions should be nearly
   invisible; high-cost or irreversible ones should command the screen with richer
   verification and explicit sign-off.

7. **Design the handoff to human judgment as a first-class moment.** The transition from
   agent autonomy to "a human needs to decide" is the most important interaction in the
   product. Give it the most care, not the least.

8. **Treat accessibility as foresight, not compliance.** Agentic interaction is
   language-first, structure-first, sequence-first — exactly how expert screen-reader
   users already navigate computing. Make state narratable, semantically structured, and
   fully navigable non-visually. "Essential for some, useful for all": it sharpens the
   glanceable experience for everyone.

## Design-review questions

Run any AI-facing UI through these:
- Which gulf does each element serve? Is evaluation getting the craft budget?
- Can the user tell *what the agent did and why* — or only *that* it finished?
- Is there a canvas to inspect/compare against, or is the user stuck in pure chat?
- Can two parts of the UI ever disagree about the same state? (They must not.)
- Does anything claim more certainty/freshness than the data guarantees?
- Can the user steer/correct/override with a real mechanism and an audit trail?
- Does scrutiny scale with the cost of being wrong?
- Could a non-visual (screen-reader) user complete the supervise-and-steer loop?

## Anti-patterns to avoid

- **Chat as the whole product.** Impressive in a demo; one-handed in practice. Add a
  verifiable surface.
- **Polishing the execution side** (slicker prompts, nicer buttons) while the evaluation
  side (does it show truth? can I trust it?) stays thin.
- **Approve/Reject with nothing to inspect.** Accountability without agency.
- **Optimistic UI that can lie.** Showing a state the system doesn't actually hold;
  reconcile to the source of truth and roll back honestly on failure.
- **Stale-as-fresh.** Reusing an old verdict after inputs changed without flagging it.

## Provenance

- John Maeda, *What is AX?* — https://maeda.pm/2026/06/11/what-is-ax/
- Don Norman, *The Design of Everyday Things* — Gulf of Execution / Gulf of Evaluation
- Jakob Nielsen — Visibility of System Status (Heuristic #1); intent-based outcome specification
- Erika Hall, *Conversational Design* (2018) — intent as the oldest interface
- Microsoft HAX Toolkit; Anthropic, *Building Effective Agents* (show the agent's planning steps)
