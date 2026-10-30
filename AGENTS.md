<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Planwerk

**A kanban board for the agentic SDLC.** Each AI agent session is a card flowing through `Define → Plan → Build → Review → Ship`. Planwerk is a *management surface, not an IDE* — show progress, decisions, and blockers; never code in the UI.

Keep these invariants in mind for every change:

- **Phase ≠ runtime status.** SDLC phase is persisted by Planwerk (SQLite); AHP runtime status (`idle`/`running`/`input-needed`/`error`) only updates card *facts*. Never let runtime status move a card between columns.
- **Gates are external and enforced.** The agent that wrote the code never grades its own work — a different reviewer (sometimes a different model) verifies. Only the gate engine transitions phase forward.
- **Autonomy is explicit and server-enforced.** The coordinator observes by default; Verify may run report-only checks/reviews, and only Coordinate may interact with sessions or advance phases. Board defaults and per-session overrides are persisted and audited.
- **Local Node.js app**, not serverless: long-lived AHP WebSocket, persistent orchestrator heartbeat, `better-sqlite3`. Next.js is just the UI layer.

Deeper context lives in `zettelkasten/vision.md` and `zettelkasten/architecture-and-design.md`.
