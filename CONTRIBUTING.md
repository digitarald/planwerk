# Contributing to Planwerk

Planwerk is an experimental, local-first tool. Open an issue before a large
change so we can agree on scope. Bug reports should describe what happened,
what you expected, and how to reproduce it. Include the app version, macOS
version and architecture, or browser and Node versions for web builds.

Do not attach databases, SDK state, session transcripts, credentials, or
unreviewed diagnostics. See [SECURITY.md](SECURITY.md) for private reports.

## Development

Use the exact Node version in [.nvmrc](.nvmrc) and npm 11:

```bash
git clone https://github.com/digitarald/planwerk.git
cd planwerk
npm ci
npm run dev
```

The [dev container](.devcontainer/devcontainer.json) supplies these tools.
Connect to an AHP 1.0.0 host to exercise live sessions. Copilot features require
the host's authentication and access to GitHub Copilot.

For native development, follow [desktop/README.md](desktop/README.md). Native
builds require macOS and Xcode command-line tools.

## Pull requests

Keep changes focused and add regression tests for changed behavior. Run the
smallest relevant tests while developing, then the checks below before opening
a pull request:

```bash
npm test
npm run lint
npm run typecheck
```

For desktop changes, also run `npm run native:test` and
`npm --prefix desktop run typecheck` after `npm run native:setup`.
Describe what you changed and what you tested. Mention any native behavior
that still needs manual verification.

Preserve these boundaries:

- Runtime status updates card facts, never the persisted SDLC phase.
- Independent reviewers verify agent work. Only the gate engine advances phases.
- Observe is the default. Server-side authorization governs automation.
- Bind the local server to loopback. Do not add unauthenticated network access.
- The UI manages work, decisions, and blockers. It is not a code editor.

See [AGENTS.md](AGENTS.md) for repository guidance and the
[architecture notes](zettelkasten/architecture-and-design.md) for context.
Contributions are licensed under the repository's [MIT license](LICENSE).
