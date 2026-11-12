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
npm run test:native --workspace @axi/tui
npm run test:workers
cargo test --locked --manifest-path packages/env/daemon/Cargo.toml
```

Vitest builds the local Env daemon before running tests, including filtered runs. This prevents tests from using an older binary after its source changes. Rust is required for these source tests. The build is incremental.

Coverage output is in `coverage/index.html` and `coverage/coverage-summary.json`. It measures the TypeScript code exercised by the local JavaScript suite. It does not measure Rust, C, subprocess internals, visual correctness or provider availability.

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

Protocol boundary checks cover text-link envelopes, OAuth callback races, MCP
reconnect limits and file-list framing. Worker and launcher checks use child
processes and verify admission, consent and shutdown. Editor model checks compare
Unicode edits and cursor positions with a plain-text model after every action.
The SQLite adapter checks confirm rollback, transaction queue isolation and
expired transaction handles. Storage-helper checks inspect the records written
by each workload; they make no performance claim.

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

Client startup checks cover an unavailable server, the initial script-watch
snapshot and static clients that reconnect without replacing bundled scripts.
Page checks also disable built-in themes and script following independently.

Surface publication checks build real plugin files and read their scripts, styles
and assets through HTTP routing. They check additions, edits, removals, old-file
expiry and retention of the last working assets after a failed replacement.
They also check asset bytes and MIME types from base builds, direct surface
accessors and the absence of automatic HTTP routes when routes are disabled.

The verification workflow runs the owned suite on its native platform matrix. Its Linux x64 job also enforces the coverage minimums, validates the behavior report, and uploads the `test-coverage` artifact.

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

The storage-driver scenarios run against memory, JSONL and SQLite. Terminal rendering scenarios send the library's output through a terminal emulator and inspect the resulting screen. Native clipboard tests use a private virtual display or a test backend, so they do not replace the desktop clipboard.

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

`packages/durable/test/process-restart-limit.test.ts` kills the waiting process
twice on both storage backends. It verifies that the restart limit ends the
interrupted tool, retains the completed sibling effect, and lets the model answer.
Parked-tool checks remove an extension before wake or cancellation and verify the
saved outcome and error report. A failing cancellation callback must still let
the task settle.

Offline provider tests inspect request encoding, device-login polling, token refresh, cancellation and malformed replies using synthetic credentials. Env tests run the generated Unix upload script in a temporary local directory. Windows command tests inspect the protocol and upload framing; native Windows execution still requires a Windows runner. Browser adapter tests use DOM event fixtures; real browser and terminal acceptance remain separate checks.

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
