# Planwerk for macOS

The Electrobun 2.0.4 npm bootstrap pins the 2.0.2 native runtime through
`hutch.config.ts`. It provides the native window, application menus, and menu-bar
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

Open the DMG, drag **Planwerk** to **Applications**, then eject the disk image.
Both the DMG and stable build output contain the real, unpacked application,
not Electrobun's self-extracting installer. Launching from Finder, the Dock, or
Spotlight starts the app directly, without installation or runtime extraction.
The packaging script uses Electrobun's complete update archive to create this
conventional DMG; update archives and metadata remain in `desktop/artifacts`.

If upgrading an older local build, quit Planwerk and replace the existing app
in Applications (or `~/Applications` if installed there). Remove any old installer
copies saved elsewhere and replace a Dock shortcut if it still targets one.
Older releases used the same name and bundle ID for the installer and the real
app, allowing Spotlight to select the installer again. Replacing the app does
not remove data in Application Support.

Node, SQLite, and the platform-specific Copilot SDK runtime are bundled; an
installed Node or Bun is not required to run it. VS Code with a compatible AHP
endpoint and Copilot authentication remain prerequisites for managing sessions.

### Optional decision-model configuration

The bundled Node server uses native `fetch` for Foundry decision inference.
It needs no Python installation or personal `decide` skill directory.
All decision families remain in legacy mode until explicitly configured.
See the root [decision-model setup](../README.md#decision-models-and-copilot-sdk-integration)
for the server-only environment variables, workload validation, and external
data-transfer boundary.

The backend inherits the desktop process environment. A development launch
from a configured terminal receives those variables. Finder and Dock launches
do not inherit exports from an unrelated terminal; configure the environment
of the actual launch process. Environment files and credentials are excluded
from packaged payloads. There is no bundled key, automatic Azure provisioning,
or new credential UI.

With `PLANWERK_DECISION_CONFIG_SOURCE=decide` in that launch environment, the
backend can reuse the skill's saved deployment and existing macOS Keychain
item directly. No credential is copied into the app bundle. The checkout's
ignored `.env.local` configures web development only, not a Finder-launched app.

## Menu and lifecycle

- The macOS traffic lights share the existing header. There is no separate
  title row. Drag the non-interactive header areas to move the window; buttons
  and workspace filters remain clickable. Desktop-only insets reserve 88 native
  points for the traffic lights and at least 44 native points of header height
  at every content zoom. The browser layout is unchanged.
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
  The native View menu also offers Split and Flightdeck. All four preserve
  workspace filters because those filters also define automation scope.
  A global menu count can therefore exceed the filtered view's count.
- The red close button and File > Close Window (Command-W) hide the retained
  window. The backend, connection and menu-bar monitoring keep running.
  Minimize and Hide Planwerk also keep the app alive. None grants additional authority.
- Reopening the app or choosing a menu destination restores the same window.
  A second launch activates the first instance rather than starting another
  server.
- While the server is ready, visible, non-minimized windows receive a renderer
  health probe every three seconds, including when reopened. A loaded document
  must acknowledge within ten seconds. An unresponsive window is recreated once,
  preserving its frame and persisted UI settings without restarting the server.
  If the replacement also fails, a native error directs you to Restart Local
  Server; automatic recovery does not loop. Restart resets the recovery limit.
  This checks JavaScript/bridge liveness, not GPU compositing or visual correctness.
  Hidden windows are not replaced. Recreated windows retain content zoom too.
- Quit stops Planwerk's server and its owned child-process group. It does not
  stop VS Code or sessions owned by VS Code. Restart Local Server requires
  confirmation because it interrupts in-flight coordinator work.
  Shutdown waits for the owned watchdog's exit event, allowing its three-second
  group-reaping deadline to finish. It does not probe a dying process group,
  which can report `EPERM` on macOS even during normal teardown. A watchdog that
  exceeds the deadline is force-stopped; signaling and exit failures remain errors.
  The window stays open until shutdown finishes. Native diagnostics record
  shutdown completion and elapsed time before requesting native exit, and a
  process-exit record when the runtime emits its exit event.

### Keyboard shortcuts

Shortcuts belong to this application and work while a text field is focused.
View destinations use the existing allowlisted hash navigation without reloading
the document. Content zoom uses WebKit page zoom, not CSS scaling.

| Shortcut | Action |
| --- | --- |
| Command-1 | Feed, filtered to unread |
| Command-2 | Board |
| Command-3 | Split |
| Command-4 | Flightdeck |
| Command-plus or Command-equals (including shifted equals) | Zoom in by 10 percentage points |
| Command-minus | Zoom out by 10 percentage points |
| Command-0 | Actual size, 100% |
| Command-W | Hide the retained window |
| Control-Command-F | Toggle native fullscreen |
| Command-Q | Quit after shutting down owned resources |
| Command-K | Existing command palette, unchanged |

Content zoom ranges from 50% to 200%. The View menu disables zoom commands at
their bounds and Actual Size at 100%. Its single native Plus key equivalent
accepts both equals variants; no global shortcut or page-to-native zoom RPC is
registered. Window > Zoom changes the window size, not content zoom.

## Data and diagnostics

Release data lives in `~/Library/Application Support/Planwerk`. Development
builds use `~/Library/Application Support/Planwerk Dev`. Both are outside the
app bundle, so rebuilding does not discard the database or SDK state.
The web app continues to use the checkout's `.planwerk` directory.
Desktop builds do not silently copy or merge the web database.

`preferences.json` in the same per-channel data directory remembers content zoom
and the last normal window frame, separately from SQLite. Zoom is reapplied after
backend reloads and renderer recovery. Move/resize saves are debounced, atomically
replace the file, and flush on hide or quit. Invalid or unreadable preferences
produce diagnostics and a native error before falling back to defaults. Save
failures are also reported and retained for a later retry.

Normal geometry excludes fullscreen, maximized and minimized frames.
Restoration chooses the available work area with the greatest overlap, falls back
to the primary display after a display is removed, and clamps size and position
to that work area. Negative coordinates on secondary displays are valid.
Unusable display information produces a warning and a centered default window.
The pinned macOS runtime's display work areas, constructor and move/resize
events use primary-display top-left coordinates. Its `getFrame()` Y instead uses
the current display's height. Persistence therefore uses event coordinates,
avoiding that mismatch on unequal-height displays.

The menu's **Show Logs** command opens the data directory. Diagnostics are local;
there is no upload or external collector:

| File | Contents |
| --- | --- |
| `desktop.log` | Native console warnings/errors, app/window lifecycle, backend failures, and WebKit DOM-ready timings |
| `server.log` | Backend/watchdog stdout and stderr, Next.js request errors, backend-ready timing, and server runtime metrics |
| `webview.log` | Browser warnings/errors, rejections, resource-load failures, and bounded UI performance batches |
| `telemetry/logs.ndjson` | Debug-level OTLP logs when the connected Agent Host advertises and supplies them |

All four files are NDJSON. Each record has a timestamp, severity, scope,
process ID, and launch `runId`; server output also carries its child process ID.
Host records retain their source timestamp and session/scope attributes, with
`recordedAt` recording local ingestion time. Filter on `runId` to follow one
launch across files. Server stderr is labelled ERROR at the stream level;
its body may contain a lower-severity library warning.

Each stream rotates continuously at 2 MiB, keeping the active file and two
backups (`.1`, `.2`): at most 6 MiB per stream, excluding explicitly saved
exports. Entries are capped at 16 KiB and oversized entries are marked
`truncated`; source time and bounded session/correlation IDs survive truncation,
but extended attributes may be dropped. Files are created with owner-only permissions. Known credential
formats and the per-launch desktop token are redacted before persistence.
Redaction is best-effort, not a guarantee that arbitrary log text is safe to share.
Webview diagnostics omit arbitrary object contents and URLs and are rate-limited
in both the page and native receiver. The bridge accepts only allowlisted
diagnostic records and numeric performance batches; it does not enable general
native RPC.

**Export Diagnostics...**, available in the menu bar and Help menu, saves a JSON
report in `diagnostics/` and opens it locally, even if the backend is unavailable.
It includes runtime/build metadata and the last 256 KiB of each active/backup
log. Missing or unreadable logs are explicitly marked. It never includes the
database, environment dump, SDK state, or conversation files. Nothing is uploaded.
Review the report before sharing; exports are explicitly saved artifacts and
remain until you delete them.

Backend debug messages are enabled by default in desktop builds. Launch with
`AHP_DEBUG=""` to disable the extra Planwerk debug messages; host OTLP subscription
still requests debug-level logs. Missing telemetry capability, subscription
failures, malformed telemetry, and persistence failures produce visible warnings
or errors rather than silently looking like an empty log.

The backend-ready and WebKit DOM-ready metrics are distinct: DOM ready is not
proof the board is interactive. Every 30 seconds the desktop backend also records
event-loop maximum/p99 delay, event-loop utilization, RSS, heap usage, and uptime.
These provide a baseline to separate backend stalls from rendering issues.

### UI performance

Desktop builds install browser monitoring before application hydration.
`webview.log` records `metric: "ui.performance"` batches. Use the outer `runId`
to join native/backend records; each batch's `documentId` and `timeOrigin`
identify a navigation. Record `startMs` and `durationMs` use that document's
monotonic browser clock, not the log's delivery timestamp.

The timeline includes preload/client startup, shell/workspace/board commits,
store hydration/storage, SSE connection and initialization, parsing, and store
application. `sse.init` includes initial connection wait; after a stream drop,
it starts again at the latest error, including browser reconnect wait. Cached
and live initialization are distinguished. Board persistence stores view
preferences, not the session-card catalog. Backend SSE metrics separately time
cached initialization, projection, and serialization.

The visible-window fallback samples every 250 ms and records excess delay of
100 ms or more, with up to six overlapping application spans. It is not a
high-resolution jank detector: shorter blocks can fall between samples.
Long-task, long-animation-frame, paint, navigation, and event observers are
feature-detected. Do not expect Chromium's long-task/long-animation-frame data
in macOS WebKit; inspect the `capabilities` record instead of treating missing
data as zero stalls.

Hidden windows stop timer sampling. Restore/visibility transitions reset the
baseline and pending input probes. Gaps over five seconds and wall/monotonic
clock disagreements are recorded as `sampling-gap` discontinuities, not hangs:
this avoids sleep false positives but can also mask a real multi-second hang.
Use a WebKit inspector CPU trace to investigate those cases.

`*.paint-opportunity` and trusted `input.next-frame` use two animation frames.
They are opportunities for paint, not proof of actual paint, usability, or INP.
A superseded board commit cancels its pending paint probe, so silence during
sustained updates is not evidence of responsiveness. Overlapping spans identify
suspects, not stack traces or proof of causation. Group records by both `name`
and `kind`: hydration and capability observations can have different kinds.

Metrics contain fixed names and numeric timings/counts, never card text, paths,
script URLs, or DOM content. The queue holds at most 40 records, batches contain
at most eight records, and overflow is counted in `dropped`. Fast spans are
aggregated in 30-second summaries; spans of 16 ms or more are recorded
individually. Delivery runs every three seconds with a separate native allowance
of 24 batches/minute, so performance traffic cannot consume the error allowance.
Export Diagnostics includes the retained performance records too.

Launch with `PLANWERK_PERFORMANCE=0` to disable browser monitoring (backend
runtime metrics remain enabled). Ordinary release builds do not collect React
render durations. For a deliberate profiling build:

```bash
PLANWERK_PROFILE=1 npm run native:build
```

That build enables `board.react-render` measurements and adds profiling overhead;
it is not the default release configuration. Rebuild with `npm run native:build`
before distributing a normal build. The [performance plan and measured
baseline](../zettelkasten/ui-performance-plan.md) record the replay results and
remaining native-WebKit validation.

SDK event metadata remains in `planwerk.db`, and SDK state in `copilot-sdk`.
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
node --test desktop/src/preferences.test.ts desktop/src/main.test.ts desktop/src/titlebar.test.ts desktop/src/navigation.test.ts
npm --prefix desktop run typecheck
npm run typecheck
npx eslint desktop/src/main.ts desktop/src/main.test.ts desktop/src/preferences.ts desktop/src/preferences.test.ts desktop/src/titlebar.ts desktop/src/titlebar.test.ts desktop/src/navigation.test.ts components/desktop-navigation.tsx components/title-bar.tsx
npm run native:build -- --dev
```

Use `npm run native:test` for the broader desktop suite. Shell-only changes can
use `npm --prefix desktop run build:dev` after a backend has been staged.

Tests cover empty and large counts, malformed responses, external-link policy,
duplicate launch, socket-file preservation, backend readiness, authenticated
status, port collisions, owned-process shutdown, persistent data paths, log
rotation/redaction, cross-layer launch IDs, browser error capture/rate limits,
offline diagnostic export, startup/runtime metric shapes, and release packaging
(runnable bundles, installer rejection, artifact paths, and packaging failures).
Focused native VM tests also cover zoom bounds/restoration, all four destinations,
close-to-hide/reopen, hidden renderer checks, fullscreen/normal geometry,
listener cleanup and explicit-quit failures. Preferences tests cover atomic
replacement, debounce, error reporting and display restoration.

On a real Mac, also verify the native window, menu, WebKit AHP connection,
close-to-hide, reopen, and Quit. With input focused, test every shortcut and draft
retention while zooming. Inspect 50%, 100% and 200% for traffic-light clearance,
header dragging, interactive controls, dialogs and scrolling. Test red-close and
Command-W, then reopen through the Dock, a second launch and menu navigation;
verify the same window and backend remain. Quit explicitly and relaunch to check
zoom and normal geometry, including after fullscreen/window Zoom and display
removal. Check both appearances and an unreachable
agent host before distributing a release. A browser-only test does not verify
these native behaviors. Trigger a console warning, a rejected promise, and a
resource-load error in WebKit and verify `webview.log`; export with the server
stopped and confirm unavailable logs are marked. Source-level bridge tests do not
replace this packaged-WebKit check.

This change was built and launched locally as an unsigned Apple Silicon
development app. Native automation verified Command-equals, Command-plus and
shifted equals in 10-point steps, the 200% bound, input draft retention while
zooming, and Command-1/3/4 navigation. Light-mode header clearance was inspected
at 100% and 200%; zoom and geometry reached the preferences file. The app later
completed owned-resource shutdown in about three seconds, with no remaining
development listener. The initiating quit shortcut was not confirmed.
Automation then refused safe input dispatch, leaving native menu clicks,
Command-2/minus/0/W/Q, 50% layout, fullscreen, close/reopen, relaunch restoration,
dragging/scrolling and dark-mode checks unverified. Multi-display cases are
covered by tests and SDK source inspection, not a hardware display-removal test.

## Publishing a native preview

GitHub releases currently publish an unsigned Apple Silicon DMG and SHA-256
checksum. Intel, Windows, and Linux binaries are not published. These previews
have no automatic updater. macOS may block the app because it is unsigned;
use Apple's per-app Privacy & Security approval only if you trust its source.
Never disable Gatekeeper globally.

The root `package.json` supplies the Electrobun app version. Before tagging,
update both package manifests and their lockfiles together:

```bash
npm version 0.2.0 --no-git-tag-version --ignore-scripts
npm --prefix desktop version 0.2.0 --no-git-tag-version --ignore-scripts
```

Use the next unused version, commit the changes, and push a matching `vX.Y.Z`
tag. The [native release workflow](../.github/workflows/release.yml) tests,
lints, type-checks, and builds on an Apple Silicon runner. It rejects mismatched
versions or architectures, verifies the DMG, and publishes a GitHub prerelease
only after the build succeeds. Only versioned DMGs and `SHA256SUMS` are uploaded,
not Electrobun update archives or local data.
Toolchain downloads get up to three setup attempts with visible warnings;
an exhausted retry still fails the release.

For a local release candidate, build normally, then run:

```bash
node scripts/prepare-native-release.mjs v0.2.0
cd desktop/artifacts/v0.2.0
shasum -a 256 -c SHA256SUMS
```

Release staging refuses to overwrite an existing version directory. Build and
prepare from the same clean tagged checkout; do not relabel an older DMG.
The backend includes Planwerk's license, Node and Electrobun notices, and a
runtime-dependency license index. See [third-party notices](../THIRD-PARTY-NOTICES.md).

## Release work still required

- Developer ID signing and notarization, including nested Node, SDK, and
  native-library executables. Current public builds are unsigned previews.
- A published, verified update channel. No automatic updater is configured.
- Intel Mac validation and an explicit supported macOS version policy.
- A deliberate migration flow for existing web data and preferences.
- A better high-resolution app icon. The current icon derives from the existing
  256px project asset.

The retained hidden webview keeps the current connection model intact.
A fully headless desktop coordinator would require moving connection ownership
out of the UI, with an explicit persisted automation scope. This release does
not introduce a second coordinator or bypass the existing gate engine.
