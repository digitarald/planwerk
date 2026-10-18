---
name: release-install
description: "Commit, push, build, and install the latest production Planwerk macOS app. Use when asked to release locally, ship and install, update the installed app, or commit/push/install Planwerk into ~/Applications."
---

# Release and install Planwerk

Run from the repository root. The default destination is
`~/Applications/Planwerk.app`; honor an explicitly requested different folder.
Read `desktop/README.md` and `scripts/build-desktop.mjs` before executing.

## 1. Preflight

- Inspect the worktree, staged changes, branch, upstream, and recent commit style.
  Include only the intended work; ask about unrelated edits. Never discard changes.
- Check Node against `package.json`'s exact `engines.node` and confirm desktop
  dependencies exist. Use existing dependencies; restore them only after a
  missing-dependency failure. Never bypass the packaging version check.
- Run focused tests for changed behavior plus typecheck and relevant lint.
  Reuse successful checks from this turn if source has not changed.
- Confirm the user authorized commit, push, replacement, and relaunch. Invoking
  this skill for the full workflow authorizes those operations; clarify a
  narrower request instead of silently expanding it.

## 2. Commit and push

- Follow the available commit and sync skills. Check the intended staged diff
  for secrets and generated output before committing. Match repository style.
  Include `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
- Do not amend, force-push, skip hooks/signing, or create a tag/GitHub release.
- Fetch the upstream remote, check ahead/behind, and stop for guidance if
  upstream changes require uncertain conflict resolution. Push normally and
  verify `HEAD` matches its upstream.
- If there are no changes, continue with the already-committed current source.
  Do not invent an empty commit.

## 3. Build production

Run `npm run native:build` and wait for success. Do not use `--dev` or install a
stale artifact after a failed build. The build packages the current architecture:

`desktop/build/stable-macos-<process.arch>/Planwerk.app`

Verify the bundle's `Contents/Info.plist` and executable exist. This output is
the unpacked app, not a self-extracting installer. Local builds are unsigned;
do not claim notarization or remove quarantine to bypass macOS protections.

## 4. Install safely

- Keep the old app running until the build succeeds. Request graceful quit
  through macOS, then verify the exact installed app's processes have stopped.
  Closing the window only hides Planwerk. If graceful quit fails, ask before
  terminating specific process IDs; never use name-based process killing.
- Stage the built bundle with `ditto` into a unique temporary directory inside
  the destination folder, preserving the complete macOS bundle.
- Move the existing `Planwerk.app`, if any, into that temporary directory as a
  rollback copy, then rename the staged bundle to `Planwerk.app`. If replacement
  fails, restore the previous bundle and report the failure.
- Never delete or migrate `~/Library/Application Support/Planwerk`, the Dev data
  directory, or the web checkout database.
- Open the installed app by its exact path. Verify its process path points to
  the destination, not the build output, DMG, or development bundle.
- Inspect the new launch in `~/Library/Application Support/Planwerk/desktop.log`
  and `server.log`. Verify backend readiness and webview DOM readiness for that
  launch, not an old successful record. If necessary, inspect the readiness
  address locally without printing authentication tokens.
- Keep the rollback copy until readiness succeeds. Then remove only that exact
  temporary installation directory. On failure, report the backup path and
  preserve it; do not claim success or silently remove the prior app.

## 5. Report

Report commit/push status, installed bundle path, production build result, and
launch verification. Distinguish installation success from Agent Host connection
or external session availability. Do not claim performance improvements without
measuring them. No dependency upgrades or unrelated cleanup.
