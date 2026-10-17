# Planwerk for macOS

Electrobun 2.0.2 provides the native window, application menus, and menu-bar
item. The window uses the system WebKit renderer, not bundled Chromium.
The desktop main process runs on Bun. The existing Next.js server, SQLite
database, and Copilot SDK still run on bundled Node.js.

## Build and run

Build on macOS with the Node version declared in the root package manifest,
npm, and Xcode command-line tools. A release currently targets the build
machine's architecture. Do not cross-compile by renaming an artifact.

From the repository root:

```bash
npm ci
npm run native:setup
npm run native:dev
```

`native:setup` installs the separate desktop lockfile and prepares the pinned
Electrobun toolchain. It does not replace the web app's package manager.
`native:dev` builds a production Next.js backend and launches a development
desktop bundle. It does not provide Next.js hot reload. After shell-only
changes, use `npm --prefix desktop run build:dev` and
`npm --prefix desktop start` to avoid rebuilding the backend.

```bash
npm run native:build
```

This builds Next.js into `.next-desktop`, stages its traced dependencies and
static assets, bundles the current Node executable, then packages the app.
The separate output directory leaves a running web development server alone.
Staging excludes local database files, environment files, and the checkout's
project-level gate configuration.

Outputs:

- `desktop/build/stable-macos-<arch>/Planwerk.app`
- `desktop/artifacts/macos-<arch>-Planwerk.dmg`

The release launcher uses Electrobun's self-extracting package format. Its first
launch extracts the app and runtime before opening the window. Subsequent
launches use the extracted app. Node, SQLite, and the platform-specific
Copilot SDK runtime are bundled; an installed Node or Bun is not required to
run it. VS Code with a compatible AHP endpoint and Copilot authentication
remain prerequisites for managing sessions.

## Menu and lifecycle

- The macOS traffic lights share the existing 44px header. There is no separate
  title row. Drag the non-interactive header areas to move the window; buttons
  and workspace filters remain clickable. The browser layout is unchanged.
- The menu-bar number counts **unread, open inbox items** for the connected
  host, across all workspaces. A separate menu row gives the unresolved count.
- Zero unread items shows the icon alone. Counts above 99 display `99+`;
  the open menu still shows the exact number.
- A native ring glyph, `◔`, marks running sessions alongside the unread number.
  For example, `◔ 4` means work is running and four inbox items are unread. The menu
  reports the exact number of running sessions across the connected host.
  This is runtime activity, not SDLC phase or percentage complete.
- A dotted ring, `◌`, means the local server is starting. An exclamation mark means
  the server or agent host is unavailable. A lost connection never becomes a
  zero count or a stale running indicator.
- The Planwerk icon is a fixed monochrome macOS template image. Indicators and
  counts use native status-item text, so macOS supplies light, dark, and
  selected-menu contrast. Electrobun 2.0.2 loses the template flag and image size
  on `setImage`; do not switch bitmap variants without addressing that limitation.
  Activity is deliberately static rather than a constantly spinning animation.
- The native process refreshes the count every three seconds through a
  read-only, authenticated local endpoint. It does not invoke inbox synthesis.
- Open Inbox selects the unread inbox view. Open Board selects the board.
  Both preserve workspace filters because those filters also define automation
  scope. A global menu count can therefore exceed the filtered view's count.
- Closing the window hides it and retains its live AHP connection. The
  coordinator continues at the existing authority level and scope.
  Hiding the app does not grant it additional authority.
- Reopening the app or choosing a menu destination restores the same window.
  A second launch activates the first instance rather than starting another
  server.
- Quit stops Planwerk's server and its owned child-process group. It does not
  stop VS Code or sessions owned by VS Code. Restart Local Server requires
  confirmation because it interrupts in-flight coordinator work.

## Data and diagnostics

Release data lives in `~/Library/Application Support/Planwerk`. Development
builds use `~/Library/Application Support/Planwerk Dev`. Both are outside the
app bundle, so rebuilding does not discard the database or SDK state.
The web app continues to use the checkout's `.planwerk` directory.
Desktop builds do not silently copy or merge the web database.

The menu's Show Logs command opens the data directory. The server writes
`server.log`; AHP telemetry lives in `telemetry`, and SDK state in `copilot-sdk`.
An optional `.github/planwerk.yml` inside the data directory supplies
app-wide configuration. Individual projects still use their own configuration.

The release server binds to `127.0.0.1:43127`; development uses port `43128`.
Stable ports preserve WebKit origin-scoped connection and view preferences.
An occupied port is an explicit startup error. Planwerk never adopts or
terminates an unrelated process to free its port.

## Boundaries

The webview has no general native RPC privileges or bundled-file access. A
restricted title-bar event can start or stop moving only its owning window.
Electrobun 2.0.2 does not expose movement in the public window API, so the main
process uses its pinned native adapter. Recheck this adapter on SDK upgrades;
do not enable the full webview RPC bridge to get drag regions.
Navigation
stays on the owned loopback origin. Supported external web, mail, and VS Code
links open through macOS rather than replacing Planwerk's window.
The tray's status endpoint requires a per-launch token retained by the native
process and server. Existing same-origin mutation checks remain in place.
As with the web app, this does not isolate Planwerk from other native processes
running as the same OS user.

## Validation

```bash
npm run native:test
npm --prefix desktop run typecheck
npm run typecheck
npm run native:build
```

Tests cover empty and large counts, malformed responses, external-link policy,
duplicate launch, socket-file preservation, backend readiness, authenticated
status, port collisions, owned-process shutdown, and persistent data paths.

On a real Mac, also verify the native window, menu, WebKit AHP connection,
close-to-hide, reopen, and Quit. Check both appearances and an unreachable
agent host before distributing a release. A browser-only test does not verify
these native behaviors.

## Release work still required

- Developer ID signing and notarization, including nested Node, SDK, and
  native-library executables. Local unsigned builds are for development.
- A published, verified update channel. No automatic updater is configured.
- Intel Mac validation and an explicit supported macOS version policy.
- A deliberate migration flow for existing web data and preferences.
- Log rotation and a better high-resolution app icon. The current icon derives
  from the existing 256px project asset.

The retained hidden webview keeps the current connection model intact.
A fully headless desktop coordinator would require moving connection ownership
out of the UI, with an explicit persisted automation scope. This release does
not introduce a second coordinator or bypass the existing gate engine.
