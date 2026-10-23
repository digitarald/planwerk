# Security

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/digitarald/planwerk/security/advisories/new).
Do not report an exploitable vulnerability in a public issue.

Include the affected version, reproduction steps, expected impact, and any
relevant configuration. Remove tokens, session content, and personal paths.
If private reporting is unavailable, open an issue asking for a private contact
without disclosing the vulnerability.

## Supported versions

Security fixes target the latest release and the `main` branch. Older previews
do not receive separate backports. Planwerk is experimental and has no security
response-time guarantee.

## Local trust boundary

Planwerk can interact with agent sessions and run configured gate commands.
Use it only with workspaces and Agent Hosts you trust. Keep its HTTP server on
`127.0.0.1`; do not expose it through a network interface, tunnel, or public proxy.
Same-origin checks do not isolate it from other processes running as your OS user.

Diagnostics stay local, but can contain sensitive information. Review exports
before sharing. Never upload the database, Copilot SDK state, or conversation
files to a public issue.

Native preview releases are unsigned and not notarized. SHA-256 checksums
detect download corruption; they are not Developer ID signatures or an
independent proof of authenticity.

Read the [security model](zettelkasten/security.md) for enforcement details and
known limitations.
