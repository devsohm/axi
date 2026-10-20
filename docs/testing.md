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

A failed stage stops the command. A native test can skip when its platform or optional display tools are unavailable. Read the test summary before treating a run as complete.

## Run focused checks

```sh
npm test
npm run test:coverage
npm run test:coverage:full
npx vitest run packages/tui/test
npm run test:native --workspace @axi/tui
npm run test:workers
cargo test --locked --manifest-path packages/env/daemon/Cargo.toml
```

Coverage output is in `coverage/index.html` and `coverage/coverage-summary.json`. It measures the TypeScript code exercised by the local JavaScript suite. It does not measure Rust, C, subprocess internals, visual correctness or provider availability.

The JavaScript runner resolves workspace package exports to their TypeScript source files. Package imports and direct source imports therefore share one module instance. The resolver honors the package's export restrictions before selecting the source file. Installed archive checks run separately with Node's normal package resolution and exercise the built JavaScript.

The regular coverage command enforces minimum execution coverage of 79% lines,
64% branches, 77% functions and 75% statements. Raise these limits as the suite
improves. `test:coverage:full` requires 100% for all four metrics and currently
fails because executable paths remain untested. No source modules are removed
from measurement to pass either command.

Use `coverage/coverage-final.json` for individual uncovered line, function and
branch locations. The HTML report displays these locations beside the source.

## Package responsibilities

| Package | Local scenarios | Main test directory |
| --- | --- | --- |
| AI | Model registration, catalogs, request encoding, streamed responses, retries, authentication flows and image/classifier adapters | `packages/ai/test` |
| Chord | Contracts, state changes, replay, connections, host lifecycle, process management, contexts, output and SQLite | `packages/chord/test` |
| Code Mode | Sandbox execution, tools, limits, cancellation, worker execution and remote execution | `packages/codemode/test` |
| Durable | Documents, conversations, forks, scheduling, recovery, tools, compaction, watches and storage drivers | `packages/durable/test` |
| Env | Connection framing, daemon lifecycle, files, watches, commands, host keys and environment contracts | `packages/env/test` and `packages/env/daemon/tests` |
| MCP | Client requests, transports, HTTP sessions, streamed events, authorization and cancellation | `packages/mcp/test` |
| Telemetry | Spans, propagation, metrics, trace queries, stored snapshots and trace rendering | `packages/telemetry/test` |
| TUI | Input, editing, history, layout, rendering, overlays, mouse interaction, formatting and native helpers | `packages/tui/test` and `packages/tui/native` |

The storage-driver scenarios run against memory, JSONL and SQLite. Terminal rendering scenarios send the library's output through a terminal emulator and inspect the resulting screen. Native clipboard tests use a private virtual display or a test backend, so they do not replace the desktop clipboard.

## Inspect behavior coverage

Run `npm run test:coverage`, then open `coverage/test-map.md`. The report counts uncovered paths, ranks modules by uncovered branches, links behavior areas to their owned test files, lists other regression files, and shows line and branch execution for every measured source module.

The area definitions are in [test-coverage.json](test-coverage.json). Keep this map current when adding a new capability. The report uses actual test results and rejects paths that no longer exist. A passed area means its listed scenarios passed; it does not claim every possible case is covered.

Use the report to find untested branches and missing behaviors. Add a scenario with explicit expected results. Do not hide untested files or create tests only to increase the percentage.

## Keep the suite compact

Add one scenario for a distinct observable behavior or failure. Use tables when several inputs share the same contract. Extend a shared driver test instead of copying it for each backend. Keep regressions that detect separate defects. Do not add tests solely to increase the count.

Check literal results, persisted state or rendered output. Assertions about mock-call counts alone do not establish correct behavior. Avoid snapshots that duplicate a whole implementation.

## Verification limits

Line and branch coverage identify untested code. Neither metric proves complete behavior or the absence of defects. Live provider and OAuth acceptance requires separate credentials and explicit runs. Native operating-system behavior requires a runner for each target. Remote SSH connectivity requires an actual remote host. Visual terminal acceptance still requires checking real terminal applications.

External compatibility suites can run separately. They supplement the local suite and are not a dependency of these commands.
