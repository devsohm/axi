# Test the toolkit

Axi's local tests run without an external source checkout or model-provider credentials. They check observable results through package APIs. Shared driver cases exercise the same contract against each supported backend.

## Run the complete local check

Install the root dependencies and isolated worker-test dependencies:

```sh
npm ci
npm ci --prefix test/workers --ignore-scripts
```

Install Rust, a C compiler and Node development headers. Native terminal builds have [platform prerequisites](../packages/tui/native/README.md). On Linux, install `Xvfb` and `xclip` to enable private-display clipboard tests.

Run:

```sh
npm run verify
```

This command builds the packages and native components, checks TypeScript, runs the JavaScript coverage suite, runs Rust and native tests, checks Durable Object execution, and verifies installed package archives. Archive verification installs dependencies into a temporary consumer and removes that consumer afterward. It does not contact model-provider APIs.

The workspace build removes each package's generated `dist` directory first. This prevents deleted source files from remaining in package archives. Source files, native binaries and dependencies are preserved.

A failed stage stops the command. A native test can skip when its platform or optional display tools are unavailable. Read the test summary before treating a run as complete.

## Run focused checks

```sh
npm test
npm run test:tooling
npm run test:coverage
npm run test:coverage:full
npm run coverage:gaps -- packages/durable/src 50
npx vitest run packages/tui/test
npm run coverage:capture
npm run coverage:merge -- /path/to/downloaded/native-coverage
npm run test:native --workspace @axi/tui
npm run test:workers
cargo test --locked --manifest-path packages/env/daemon/Cargo.toml
```

Vitest builds the local Env daemon before running tests, including filtered runs. This prevents tests from using an older binary after its source changes. Rust is required for these source tests. The build is incremental.

Coverage output is in `coverage/index.html` and `coverage/coverage-summary.json`. Istanbul measures the TypeScript code exercised by the JavaScript suite. The test loader also records source executions in Node child processes and worker threads that inherit its environment. Forced termination can prevent the final snapshot. The Chromium fixture and the workerd integration test report their instrumented source execution to the same collector. Rust, C, visual correctness and live-provider availability require separate checks.

The compiled sandbox fixture starts its real JavaScript worker and reports the bundled host's execution to the collector. This covers worker discovery from a built module as well as from a TypeScript source module. Its bundle uses the same source instrumentation and counter maps as the source tests.

The JavaScript runner selects package tests from the root manifest's eight workspaces and integration tests from `test/*.test.ts`. Measured source files come from the eight workspaces. It resolves workspace package exports to their TypeScript source files. Package imports and direct source imports therefore share one module instance. The resolver honors the package's export restrictions before selecting the source file. Installed archive checks run separately with Node's normal package resolution and exercise the built JavaScript.

The regular coverage command enforces minimum execution coverage of 90% lines,
78% branches, 88% functions and 87% statements. Raise these limits as the suite
improves. `test:coverage:full` requires 100% for all four metrics and currently
fails because executable paths remain untested. No source modules are removed
from measurement to pass either command.

Use `coverage/coverage-final.json` for individual uncovered line, function and
branch locations. The HTML report displays these locations beside the source.
`npm run coverage:gaps -- <path filter> <limit>` lists uncovered statements,
functions and branches with their source lines. Run coverage first to refresh
the measurements.

The coverage fixture checks parent, child-process and worker-thread execution
against a disabled-collector control. It checks exact invocation counts,
unexecuted functions, both branches, dynamic imports, reload URLs, exit handlers and application warnings.
It also checks source locations and counts for native imports that bypass the
test runner's module loader.
Collection rejects incompatible source maps. Type-only source modules stay in
the inventory after the instrumenter confirms that they have no executable
counters.

The collector compiles measured sources with the same esbuild version and Node 22
target in every runtime. This supports private overloads and resource disposal
syntax on the minimum Node version and keeps counter maps consistent. Windows
paths are normalized before reports are combined.

The workerd case in the JavaScript suite runs workspace source. It skips on
Windows or when the isolated worker dependencies are absent. Linux CI installs
those dependencies. `npm run test:workers` separately checks the built packages
and the Code Mode deployment example. `verify` runs both forms.

`coverage:capture` records a passing local report with its commit, runtime,
instrumentation versions and SHA-256 hash of every measured source module. It
also records hashes of the test configuration, collector scripts and shared instrumenter. It
also writes portable source paths. Run it after `test:coverage`; `verify` runs
both commands in that order.

`coverage:merge` combines the six native CI artifacts in the supplied directory.
It requires one artifact per operating system and architecture. It rejects
different commits, source bytes, instrumentation versions, missing source
modules and incompatible counter maps. Counter IDs may differ; source positions
identify matching counters. Results are written to `coverage/combined`.

The combined report credits code executed on another native platform. It does
not credit unexecuted code, unreported browser execution or native
Rust and C code. An uncovered path can be reachable, platform-specific or
unreachable under the documented contract. Investigate the path before adding
a test. Do not fabricate an invalid internal state or remove a measured module
to increase the percentage.

Protocol boundary checks cover text-link envelopes, OAuth callback races, MCP
reconnect limits and file-list framing. Worker and launcher checks use child
processes and verify admission, consent and shutdown. Editor model checks compare
Unicode edits and cursor positions with a plain-text model after every action.
The SQLite adapter checks confirm rollback, transaction queue isolation and
expired transaction handles. Storage-helper checks inspect the records written
by each workload; they make no performance claim.

Delta model checks apply batches of edits to both tracked state and ordinary
JavaScript values. They compare the resulting value, delta replay, aborted
changes and retained revisions. Reference lifetime checks cover members, keyed
documents and event subscriptions after release or host closure. Nested-tool
checks verify result conversion, structured-output errors, keyed child reuse and
the explicit keys required after a wake. Generation review checks validate
continuation content before another request starts.

Task-runtime checks cover child ownership, abort controls, document history,
entry paging and invocation cleanup. SQL expression cases compare known results
with both the in-process evaluator and SQLite. Terminal checks cover negotiation,
exit restoration, Unicode deletion, character search and paste handling. MCP
credential checks exercise concurrent refresh, token rotation and failed refresh
recovery. Filesystem checks cancel reads after the daemon replies and confirm
that the connection remains usable. App checks cover live and dormant worker
archives, server-owned records, failed replacements and exclusive data-directory
locks. Host-data checks compare stored row and JSON-cell versions after migration
and reject malformed archives before they can change existing data.

Browser-page checks use a real local WebSocket server with controlled DOM events.
They check bootstrap validation, rendering after initialization, theme and language
setup, telemetry delivery, and the server identity check before reconnecting.
These checks do not establish visual browser correctness.

Mounted React hook checks run in Chromium. Install `/usr/bin/chromium` or
`/usr/bin/chromium-browser`, or set `CHROMIUM_BIN` to its executable path. The test
uses an isolated temporary browser profile and skips when Chromium is absent.
The temporary profile disables background networking and uses its own password
store instead of the operating system's keychain.
It checks live values, page-state retention, language changes, event listeners
and reference release on unmount. The page reports completion to a local HTTP
test server. Chromium startup has a separate deadline from the page's checks.
The driver waits for subscriptions before emitting transient events. A rendered
view alone does not mean that React's passive subscription effect has finished.
During coverage runs, the fixture reports its source execution before it posts the result. Other browser checks remain separate unless they report their own instrumented execution.

Linux CI starts a private D-Bus session for the JavaScript suite. For a headless
Linux checkout, install `dbus-daemon` and run `dbus-run-session -- npm test` to use
the same setup. The session ends with the test command, as described in the
[dbus-run-session manual](https://dbus.freedesktop.org/doc/dbus-run-session.1.html).
These tools are test prerequisites, not Axi runtime dependencies.

Client startup checks cover an unavailable server, the initial script-watch
snapshot and static clients that reconnect without replacing bundled scripts.
Page checks also disable built-in themes and script following independently.

Surface publication checks build real plugin files and read their scripts, styles
and assets through HTTP routing. They check additions, edits, removals, old-file
expiry and retention of the last working assets after a failed replacement.
They also check asset bytes and MIME types from base builds, direct surface
accessors and the absence of automatic HTTP routes when routes are disabled.

The verification workflow runs owned tests and coverage checks on all six native
targets. Each job uploads `test-coverage-<target>`. The archive job verifies and
merges those reports into `combined-coverage`. Linux x64 also runs the tooling
tests. Per-platform behavior reports remain separate; the combined report
contains execution counters, not a claim of complete behavior.

## Package responsibilities

| Package | Local scenarios | Main test directory |
| --- | --- | --- |
| AI | Model registration, catalogs, request encoding, streamed responses, retries, authentication flows and image/classifier adapters | `packages/ai/test` |
| Objects | Contracts, state changes, replay, connections, host lifecycle, process management, contexts, output and SQLite | `packages/objects/test` |
| Code Mode | Sandbox execution, tools, limits, cancellation, worker execution and remote execution | `packages/codemode/test` |
| Durable | Documents, conversations, forks, scheduling, recovery, tools, compaction, watches and storage drivers | `packages/durable/test` |
| Env | Connection framing, daemon lifecycle, files, watches, commands, host keys and environment contracts | `packages/env/test` and `packages/env/daemon/tests` |
| MCP | Client requests, transports, HTTP sessions, streamed events, authorization and cancellation | `packages/mcp/test` |
| Telemetry | Spans, propagation, metrics, trace queries, stored snapshots and trace rendering | `packages/telemetry/test` |
| TUI | Input, editing, history, layout, rendering, overlays, mouse interaction, formatting and native helpers | `packages/tui/test` and `packages/tui/native` |

The storage-driver scenarios run against memory, JSONL and SQLite. Terminal rendering scenarios send the library's output through a terminal emulator and inspect the resulting screen. Linux clipboard scenarios use a private virtual display, and shared bridge tests use a test backend. Windows CI also enables real clipboard round trips on its disposable desktop. See the [native helper guide](../packages/tui/native/README.md) before enabling those checks locally.

Array range checks compare 1,200 combinations with native JavaScript and replay
each resulting revision. Store import and replication checks reject malformed
schemas, rows, conditions and expressions, then confirm that rejected writes did
not change the stored state. Login and invitation tests run through the HTTP
component, including authentication, single-use links and expiration.

Daemon protocol checks use a real child process. They send corrupt frames,
exercise cancellation and reconnects, and advance handshake and heartbeat
deadlines with a controlled clock. MCP checks cover split UTF-8 streams, message
limits, peer loss and pipe shutdown. Durable checks include all three join policies,
automatic compaction, overflow recovery and composed request hooks. Fullscreen
search tests inspect the terminal emulator after navigation, updates and resize.

Controlled pipe-error fixtures replace both process creation and termination.
They never signal an unspawned operating-system handle. Separate stdio lifecycle
checks start real children and verify their termination.

SSH bootstrap checks execute the generated shell scripts through a local proxy.
The proxy preserves the command's exit status when the command closes input
early. These cases do not contact an SSH server.

Editor tests cover completion by keyboard and mouse, paste-marker deletion,
history limits and Unicode wrapping. Overlay tests cover focus restoration,
visibility on resize, anchors and terminal color queries. Color tests inspect
terminal cells for every text-attribute combination and confirm that later text
does not inherit those attributes.

Generation tests cover parallel and sequential tool calls, turn budgets,
termination, handoff and rejected after-run task requests. SQLite recovery tests
restore interrupted requests and deferred polls under both retry policies. Code
Mode tests reject expired or incompatible saved runs, reuse committed results,
and retain successful state when saving long output fails.

Compiler checks verify tool argument inference for structural and generated
schemas, nested containers, property modifiers, cancellation and preparation.
They also verify typed host addresses and reject optional host columns.

Scheduler tests cover abandoned work after restart, incompatible task
definitions, phase handover, abort failures and background cancellation.
Rejected sleep deadlines roll back document changes and leave the task usable.
Queued-input checks verify cancellation across task-owned conversations while
retaining queued writes and inputs outside the selected scope. Compaction checks
cover retry limits, unavailable models, custom summaries and request cancellation.
Document tests check deferred deadlines, migration, unloading, observer
cancellation, retirement and historical entry boundaries.
Live-state migration tests open version 1 and 2 documents on SQLite and JSONL.
They check read-only migration, the saved version after a transaction, and the
value after closing and reopening storage.
Tool-result boundary checks reject non-finite numeric details, clear the tool's
live progress, and let the next generation run.
Shell output checks run a real command with an overlong final line and compare
its retained tail and complete spill file, with and without a final newline.
Image checks run both direct processing and real worker requests. They compare
pixel positions, orientation, dimensions and byte limits. Concurrent requests
use separate limits and preserve their caller's input bytes.
Controlled worker failures check startup fallback, rejection of pending images
after worker loss, and isolation of individual image errors.
File-tool scenarios check image size refusal, BMP conversion, resize diagnostics
and continued use of the conversation after a decoder refusal.
Durable's Code Mode scenarios run real scripts to check the four-call model
limit, queued calls after script completion, usage totals, classifier failures
and displayed or unused generated images.

Fullscreen tests cover captured mouse drags, nested wheel scrolling, search
controls, selection auto-scroll and terminal mode restoration. Scrollback tests
check large Unicode writes, saved render state, image retransmission and removed
lines. AI tests exercise streamed grammar input, reasoning, refusals and terminal
provider statuses. Code Mode tests enforce remote memory caps, output batching,
exchange failure cleanup and worker ownership.

AI executable checks run in empty temporary directories and confirm that help,
listing and invalid login choices do not create credentials. Provider protocol
tests use synthetic credentials and controlled responses; they do not establish
that a live provider accepts a request.

`packages/durable/test/process-recovery.test.ts` kills its own child process during
a run. It checks direct tools and Code Mode on SQLite and JSONL. After reopening,
the test resumes the pending safe tool and verifies submission deduplication.
Completed tool effects and nested Code Mode calls are not repeated. The resumed
script saves its final values. The fixture uses synthetic model responses.

Recovery checks also kill a process after its answer and a review task checkpoint
are stored. Reopening SQLite and JSONL must finish that task without repeating
the answer, the hook or the saved checkpoint.

Objects job checks kill a child after its state commits to SQLite. Reopening must
retain the job ID and saved state. The `rerun` policy invokes the job again; the
`abandon` policy finishes it with a restart failure without invoking it. Both
checks await the finish transaction and verify that no active run remains.

`packages/durable/test/process-restart-limit.test.ts` kills the waiting process
twice on both storage backends. It verifies that the restart limit ends the
interrupted tool, retains the completed sibling effect, and lets the model answer.
Parked-tool checks remove an extension before wake or cancellation and verify the
saved outcome and error report. A failing cancellation callback must still let
the task settle.

Offline provider tests inspect request encoding, device-login polling, token refresh, cancellation and malformed replies using synthetic credentials. Retry tests cover cancellation before and during backoff, retry limits and terminal errors. These checks do not contact model providers.

Env tests run the generated Unix upload script in a temporary local directory. Windows-only Durable tests run real PowerShell commands, retain UTF-8 output and finish when a detached descendant keeps a pipe open. The workflow runs them on Windows x64 and arm64. Browser adapter tests use DOM event fixtures; real browser and terminal acceptance remain separate checks.

MCP checks bound pagination, isolate failing progress and close listeners, and
reject unsupported HTTP response types without disabling later requests. An
invalid SSE event must still allow a later valid notification through.
Env checks close a real daemon connection with readers still open. Later reader,
file, watch and command operations must return errors without starting a new daemon.

Native discovery tests check packaging paths, unavailable modules, optional
modifier support and a Linux display becoming available after startup. They mock
the platform and module loader. They do not replace native tests on each operating
system. Transient-event tests exercise older contract readers locally and over a
memory link, including mapping failures, refusal and subscription release.

## Platform and terminal checks

The native workflow runs on Linux, macOS and Windows for x64 and arm64. Each job
builds the Env daemon and terminal helper, checks types, runs owned tests and
installs the package archives. Android jobs cross-compile the Env daemon for
x64 and arm64. Separate x64 emulator jobs run the remote environment acceptance
driver on API 24 and 36. These jobs do not establish runtime acceptance on an
arm64 device. Node 22 and 24 compatibility jobs reuse the Linux x64
binaries once that target passes. Other native targets continue independently.
The combined archive waits for every target and both compatibility jobs.

`packages/env/test/remote-acceptance.ts` checks an explicitly supplied disposable
remote machine. Build the workspace first; the driver uses built package exports
so it also runs on Node 22. It verifies a 1.7 MB binary transfer, UTF-8 commands, ordered
process pipes, timeout, filesystem watching, PTY input and dimensions, and reads
after a fresh connection. It removes its temporary remote directory and closes
the connection. It does not read local credentials or choose a remote host.

For an already deployed daemon, supply the command that starts its binary over
an unmodified byte stream, followed by the remote shell path:

```sh
node packages/env/test/remote-acceptance.ts '["ssh","-T","test-machine","/path/to/axi-env"]' /bin/sh
```

The driver uses `stty size` to check PTY dimensions. On machines without `stty`,
pass a terminal-size command as its final argument. Android CI compiles
`packages/env/test/fixtures/terminal-size.c` with the NDK and deploys that small
probe beside the daemon. The probe reads the actual PTY dimensions with `ioctl`.

For deployment checks, import `verifyRemoteEnvironment` and pass a factory that
returns the connection from `connectSsh`. Check the deployment path separately
with `deployDaemon`. Keep test host keys and credentials outside the repository.

A manual workflow dispatch can supply an additional Windows acceptance script.
The workflow writes that script into the runner's temporary directory, executes
it after the native components and owned suite pass, and then removes it. This
input requires permission to dispatch repository workflows. It is not evaluated
for push or pull-request runs. Write its receipts into `coverage/acceptance` to
include them in the Windows coverage artifact. The script does not ship in the
toolkit archives.

The Objects terminal launcher's sandbox scenarios require Node 26.5.1 or later.
Node 22 and 24 still run the launcher's protocol and unsupported-runtime checks.
Its thirteen sandbox integration cases run in the native Node 26 jobs. The
standalone TUI library's tests remain enabled on all supported Node versions.

Tests follow each operating system's contracts. Unix permission-bit assertions
and stale Unix socket-file cleanup do not run on Windows. A separate process-lock
test checks exclusion, cancellation and reacquisition through the active backend.
Windows file-conformance tests request native symlinks from Git Bash, since its
default `ln -s` behavior can copy the file instead. Discovery fixtures resolve
temporary directories before comparing canonical paths, including Windows' short
directory aliases.

The macOS file-watcher scenario separates fixture setup and successive edits
across FSEvents batches. Each transition still requires the expected change mark.

MCP write-error checks inject a failing writable pipe on every platform and
assert both the rejected send and the error notification. A separate Unix test
closes a real child's input descriptor. This descriptor test is skipped on
Windows; the rest of its real stdio lifecycle tests still run there.

`packages/tui/test/interactive-terminal.test.ts` runs a built TUI in a real Unix
pseudoterminal. It checks both screen modes with Unicode paste, submission,
overlays, 2,000-row expansion, streaming updates, resize and exit. Kitty key press
and release reports must toggle a control only once. The fixture checks raw-mode
restoration and removal of its input and resize listeners. Screen assertions use
a terminal emulator. Visual appearance in other terminal applications remains a
separate acceptance check.

Archive lifecycle tests read valid and invalid inputs and stop iteration early.
Each case must release its input stream before the caller reuses the file.

## Inspect behavior coverage

Run `npm run test:coverage`, then open `coverage/test-map.md`. The report counts uncovered paths, ranks modules by uncovered branches, links behavior areas to their owned test files, lists other regression files, and shows line and branch execution for every measured source module.

The area definitions are in [test-coverage.json](test-coverage.json). Keep this map current when adding a new capability. The report uses actual test results and rejects paths that no longer exist. A passed area means its listed scenarios passed; it does not claim every possible case is covered.

The map must list every workspace exactly once. Each area needs test files owned by that package, and each package needs measured source execution. `npm run test:tooling` checks valid reports and rejects missing packages, empty areas, foreign test paths, and packages with no measured source execution. It also checks that the JavaScript runner selects every owned package and integration test. Build checks verify stale output removal, source preservation and failure reporting in temporary workspaces.

Use the report to find untested branches and missing behaviors. Add a scenario with explicit expected results. Do not hide untested files or create tests only to increase the percentage.

## Keep the suite compact

Add one scenario for a distinct observable behavior or failure. Use tables when several inputs share the same contract. Extend a shared driver test instead of copying it for each backend. Keep regressions that detect separate defects. Do not add tests solely to increase the count.

Check literal results, persisted state or rendered output. Assertions about mock-call counts alone do not establish correct behavior. Avoid snapshots that duplicate a whole implementation.

## Verification limits

Line and branch coverage identify untested code. Neither metric proves complete behavior or the absence of defects. Live provider and OAuth acceptance requires separate credentials and explicit runs. Native operating-system behavior requires a runner for each target. Remote SSH connectivity requires an actual remote host. Visual terminal acceptance still requires checking real terminal applications.

External compatibility suites can run separately. They supplement the local suite and are not a dependency of these commands.
