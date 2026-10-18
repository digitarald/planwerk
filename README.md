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
against AHP 1.0.0 and does not connect to older protocol versions.

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

### Native macOS app

Planwerk also runs in an Electrobun desktop app using the macOS WebKit renderer.
The app bundles its Node server and has a native menu-bar inbox count.

```bash
npm run native:setup
npm run native:dev
```

To produce the macOS app and DMG for your Mac's architecture:

```bash
npm run native:build
```

The installer is written to `desktop/artifacts/macos-<arch>-Planwerk.dmg`.
These local builds are unsigned and not notarized. They are not yet a public
distribution release. See [desktop/README.md](desktop/README.md) for lifecycle,
data storage, validation, and release requirements.

All builds offer only AHP 1.0.0. Hosts must accept that version; Planwerk does
not retry with older or untested protocol versions.

> **Security:** Planwerk's default commands bind only to `127.0.0.1`. This is
> required when using **VS Code (local)** because that endpoint can control the
> desktop Agent Host and its Copilot sessions. Do not expose Planwerk on a
> network interface unless you add authentication and a separate trust boundary.

High-risk CTO decisions use expiring, one-time capabilities delivered only to
the originating local UI flow. This prevents approval-ID guessing and replay,
but does not authenticate other native processes running as the same OS user.
See [`zettelkasten/security.md`](zettelkasten/security.md) for the trust model
and limitations.

## Copilot SDK integration

Risk triage, coherence reviews, gate verdicts, and inbox briefings use the SDK's
typed structured-output API. Zod schemas constrain the response format and
validate the returned object; semantic checks still reject contradictory
verdicts and disallowed inbox actions. Invalid or missing responses retain each
caller's conservative fallback rather than being accepted as successful work.

Generated SDK prompts are attributed to `system`. Human CTO messages retain
`user` provenance, with the current board snapshot supplied separately as
untrusted context in the session's appended system message on create and resume.
Provenance does not grant authority: server-side gates and permission checks
still authorize every action.

Runtime recovery distinguishes JSON-RPC transport errors from domain failures
using the SDK's shared `vscode-jsonrpc` error classes and codes. Message matching
is a compatibility fallback for unstructured errors, not an override for
structured domain errors.
Keep the direct `vscode-jsonrpc` pin aligned with the SDK: a regression test
checks that both resolve the same module so error constructor identities match.

## Folder configuration

Each local workspace can supply `.github/planwerk.yml` or
`.github/planwerk.yaml`. Planwerk searches from the session's working directory
up to its repository root and uses the nearest configuration. If both extensions
exist in the same folder, `.yml` wins. Configurations are not layered: omitted
settings use Planwerk's built-in defaults, not a parent project's settings.
A workspace without a configuration does not inherit Planwerk's own project
configuration. Remote workspace URIs cannot load local configuration files.

The configuration supports custom gate scripts, review skills and prompts,
phase gates, per-risk review policies, orchestrator settings, WIP limits, and
coherence settings. See [this project's configuration](.github/planwerk.yml)
for an example. Gate commands still run in the session's working directory,
not the directory containing the YAML.

To keep a notes or product-brain folder off the board, put this in that folder's
`.github/planwerk.yml`:

```yaml
enabled: false
```

Reconnect the board after editing configuration to refresh the whole list.
Disabled folders are excluded from cached and live board cards, the workspace
picker, and coordinator automation; an unfiltered board cannot opt them back in.
A multi-folder session is excluded if any of its folders is disabled.
This does not archive or delete the underlying Copilot sessions or their history.
It also does not erase previously recorded inbox items.

### Risk guidance

Risk triage considers impact, blast radius, reversibility, exposure, and
uncertainty. File and line counts inform scope but do not force the model to
return high risk. Titles and summaries are interpreted in context rather than
classified by sensitive keywords alone.

The rubric separates subject matter from operational effects, and file format
from authority. It asks what the changed material controls, which resource could
be affected, and how a failure could be recovered. Documentation is not
automatically harmless, and a small configuration edit can have broad authority.
Missing or stale evidence is an explicit uncertainty, not proof of damage.
Explanations must connect the current evidence to a consequence, containment
property, recovery path, or specific evidence gap rather than repeat a generic
scope label.

Use project guidance to describe consequences and recovery constraints:

```yaml
risk_assessment:
  guidance: |
    This tool runs locally and has no production deployment.
    Evaluate whether changes could lose user-authored notes or publish them.
    Routine editing is reversible through Git; bulk rewrites need recovery evidence.
```

Guidance is domain context, not a fixed risk override. Incomplete verified file
evidence and sensitive file paths still impose a high-risk floor. If the model
is unavailable or returns invalid output, conservative keyword- and size-based classification
remains the fallback. Changes to guidance or the shared rubric invalidate prior
assessments; reassessment runs for eligible cards without waking cold sessions
merely to collect evidence.

Configuration edits are detected on subsequent reads. Invalid YAML or invalid
`enabled` / `risk_assessment.guidance` values raise an explicit error rather
than silently enabling a folder or falling back to a different policy.

## Learn more

- [`zettelkasten/vision.md`](zettelkasten/vision.md) — the problem, principles, and north star
- [`zettelkasten/architecture-and-design.md`](zettelkasten/architecture-and-design.md) — design decisions, tech stack, and structure
