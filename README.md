# Planwerk

> The management surface for agentic software development.

AI agents write 4x more code — but most of that speed gets eaten by the verification work humans still do by hand. Review queues are overflowing, sessions get babysat one at a time, and there's no single place to see what every agent is actually doing.

**Planwerk is an inbox and kanban board for the agentic SDLC.** The inbox tells you
what deserves attention next; the board shows where every session is in
`Define → Plan → Build → Review → Ship`. Quality gates block every phase
transition, and a coordinator works at the authority level you choose: observe,
verify independently, or coordinate sessions after gates pass.

## Why it's different

- **A management surface, not an IDE.** See progress, decisions, and blockers — no code in the UI.
- **Gates are external and enforced.** The agent that wrote the code never grades its own work. A different reviewer — sometimes a different model — verifies it.
- **Autonomous by choice, accountable always.** Observe is the safe default. Verify adds checks and independent reviews. Coordinate may interact with sessions and advance phases, with every policy change and action logged.
- **Risk-proportional.** A typo fix gets auto-merged; a security change gets adversarial review, multiple reviewers, and human sign-off.

## How it works

Cards are live agent sessions. A persistent coordinator detects stuck sessions, assigns risk levels, and surfaces WIP or coherence issues in **Observe** mode. **Verify** may also run configured checks and report-only independent reviews. **Coordinate** adds permission to answer or guide managed sessions and advance phases after gates pass. The board default can be overridden per session; explicit human actions remain available in every mode.

Before leaving Build, deterministic checks and an independent implementation review establish that the code builds, is correct, and is architecturally sound. Review then compares the final implementation and gate evidence with the original intent in `plan.md`, producing a required sibling `review.md` that records validation, divergences, unresolved risks, and the ship recommendation.

Meaningful handoffs land in a durable inbox. A revision-bound Chief of Staff
pass turns the source facts into one concise, situation-aware note and chooses
the most useful real action to put first. It can frame an outcome, decision,
risk, unblocker, or no-action update without filling in a rigid template.
Read state stays separate from unresolved action, so looking at a blocker never
makes it disappear. Inbox, split, and board views are always one click apart.

The coordinator drawer accepts plain-language commands — *"start a task for rate
limiting,"* *"why is auth stuck?"*, *"pause all sessions."*

Planwerk manages the AI execution layer between "task defined" and "PR merged," integrating with GitHub Issues, Projects, and PRs rather than replacing them.

## Getting started

Planwerk requires Node.js 24.17.0 and npm. It runs locally and connects to an Agent
Host Protocol endpoint, such as the one provided by VS Code. The app is built
against AHP 0.9.0 and does not connect to older protocol versions.

```bash
npm exec --yes --package=npm@11.13.0 -- npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and connect to your Agent Host Protocol endpoint to start managing sessions.

### Dev container

With Docker and the VS Code Dev Containers extension installed, run
**Dev Containers: Reopen in Container**. The container installs the exact Node.js
and npm versions declared by the project, installs dependencies, and forwards
Planwerk on [http://localhost:3000](http://localhost:3000).

Development and test builds can reconnect once with a newer exact protocol
version reported by a VS Code Insiders host. Production builds remain pinned
to AHP 0.9.0.

> **Security:** Planwerk's default commands bind only to `127.0.0.1`. This is
> required when using **VS Code (local)** because that endpoint can control the
> desktop Agent Host and its Copilot sessions. Do not expose Planwerk on a
> network interface unless you add authentication and a separate trust boundary.

High-risk CTO decisions use expiring, one-time capabilities delivered only to
the originating local UI flow. This prevents approval-ID guessing and replay,
but does not authenticate other native processes running as the same OS user.
See [`zettelkasten/security.md`](zettelkasten/security.md) for the trust model
and limitations.

## Learn more

- [`zettelkasten/vision.md`](zettelkasten/vision.md) — the problem, principles, and north star
- [`zettelkasten/architecture-and-design.md`](zettelkasten/architecture-and-design.md) — design decisions, tech stack, and structure
