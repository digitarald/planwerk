# Planwerk

> The management surface for agentic software development.

AI agents write 4x more code — but most of that speed gets eaten by the verification work humans still do by hand. Review queues are overflowing, sessions get babysat one at a time, and there's no single place to see what every agent is actually doing.

**Planwerk is a kanban board for the agentic SDLC.** Each agent session becomes a card flowing through `Define → Plan → Build → Review → Ship`. Quality gates block every phase transition, an AI orchestrator manages the work autonomously, and you direct from a single board instead of micromanaging each session.

## Why it's different

- **A management surface, not an IDE.** See progress, decisions, and blockers — no code in the UI.
- **Gates are external and enforced.** The agent that wrote the code never grades its own work. A different reviewer — sometimes a different model — verifies it.
- **Autonomous but accountable.** The orchestrator monitors, intervenes, and enforces, but logs every decision so you can override with a full audit trail.
- **Risk-proportional.** A typo fix gets auto-merged; a security change gets adversarial review, multiple reviewers, and human sign-off.

## How it works

Cards are live agent sessions. A persistent orchestrator ("CTO agent") detects stuck sessions, assigns risk levels, manages WIP, and escalates to you only when judgment is needed. Before leaving Build, deterministic checks and an independent implementation review establish that the code builds, is correct, and is architecturally sound. Review then compares the final implementation and gate evidence with the original intent in `plan.md`, producing a required sibling `review.md` that records validation, divergences, unresolved risks, and the ship recommendation.

A conversational sidebar lets you command the orchestrator in plain language — *"start a task for rate limiting,"* *"why is auth stuck?"*, *"pause all sessions."*

Planwerk manages the AI execution layer between "task defined" and "PR merged," integrating with GitHub Issues, Projects, and PRs rather than replacing them.

## Getting started

Planwerk requires Node.js 24 and npm. It runs locally and connects to an Agent
Host Protocol endpoint, such as the one provided by VS Code.

```bash
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and connect to your Agent Host Protocol endpoint to start managing sessions.

> **Security:** Planwerk's default commands bind only to `127.0.0.1`. This is
> required when using **VS Code (local)** because that endpoint can control the
> desktop Agent Host and its Copilot sessions. Do not expose Planwerk on a
> network interface unless you add authentication and a separate trust boundary.

## Learn more

- [`zettelkasten/vision.md`](zettelkasten/vision.md) — the problem, principles, and north star
- [`zettelkasten/architecture-and-design.md`](zettelkasten/architecture-and-design.md) — design decisions, tech stack, and structure
