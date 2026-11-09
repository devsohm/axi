# Execution environment specification

`@axi/env` connects a Durable execution environment to a native daemon. The daemon can run locally or through SSH. It does not provide a terminal application or a security sandbox.

## Public interfaces

| Interface | Responsibility |
| --- | --- |
| `Connection` | Lazy daemon startup, framed requests, progress, cancellation and session identity |
| `RemoteExecutionEnv` | Durable file, command and watch operations on the remote machine |
| `LocalExecutionEnv` | Durable Node operations with native daemon file listing |
| `RemoteTerminal` | Raw terminal bytes, ordered input, resize, foreground job and exit |
| `RemoteProcess` | Separate binary input and output pipes, ordered writes, stdin close and process-group lifetime |
| `RemoteWatcher` | Watch establishment, loss recovery and gap notification |
| SSH helpers | Host-key trust, platform detection and verified binary deployment |

The [wire protocol](protocol.md) defines operation fields, framing and limits. [Environment semantics](semantics.md) defines file behavior, path rules, execution result precedence and cancellation checkpoints.

## Ownership

The caller owns a connection and closes it explicitly. Several environments may share it. Environment cleanup kills commands belonging to that environment; it does not close the connection.

Readers, writers, watchers and terminals own their request or handle lifetime. File handles belong to the exact daemon session that created them. Requests using a handle from a lost session fail instead of reaching a replacement daemon. Close readers, stop watchers and close terminals when their owner finishes.

Connection close is terminal. Unplanned connection loss rejects pending work, marks the loss and permits a later operation to start a fresh daemon. A lost mutation or command response does not prove that its operation never executed. The library does not automatically replay unknown external effects.

`openProcess()` requires the daemon's `process` feature. It resolves after the `started` event and exposes the request's eventual exit separately. Input writes target the original daemon session. Closing stdin follows queued writes; later input is dropped by the client and rejected with `EBADF` by the daemon. A completed process ends its process group before reporting its exit. Output bytes from each stream are delivered before the exit result.

## Failure and cancellation

Environment file methods return Durable `Result` values. Known remote error codes map to stable `FileError` codes; other names map to `unknown`. Existing `FileError` instances retain their identity. Diagnostic messages and native error details may vary by platform.

Cancelling a request or `info(signal)` during startup stops that caller's wait immediately with `aborted`. The shared connection continues starting for other callers. File operations also stop waiting for startup when their context is cancelled.

After a request is sent, cancellation sends a cancel frame and waits up to one second for the daemon's result or error. If the daemon does not answer, the client returns `aborted` and ignores a later reply. A remote command timeout also runs on the client, covering connection startup and an unresponsive daemon. Cancellation of a command or terminal kills its process group. Explicit kill can stop a command without classifying the request as aborted. Short file operations can finish normally after cancellation is requested. Callers must follow the operation-specific checkpoints in the semantics document.

An output callback failure takes precedence over a command failure. Command timeout, abort, spill failure and process exit follow the documented precedence. Complete output can spill to a file independently of the retained display window.

## Transport and recovery

Daemon startup requires a random-token greeting and a protocol handshake. Earlier shell output is diagnostic noise. Framing is length-prefixed, bounded and validated; corrupt frames end the connection. Session payloads are copied before delivery. Progress events do not settle their request.

Connection and daemon pings detect silence. Reconnected watchers establish new coverage and report overflow because changes during the gap are unknown. Watch paths use remote filesystem rules. Listing observes its configured count, byte and time limits and reports truncation explicitly.

SSH host keys are supplied through an explicit known-hosts file and alias. Applications compare newly scanned keys through a trusted channel before accepting them. Deployment verifies the binary content and activates it only after the uploaded checksum agrees. The remote machine needs the native executable; it does not need Node or Rust to run it.

## Platform boundaries

SSH uses a 15-second connection timeout and keepalives for an established connection.

The client follows the remote machine's path, file, environment and executable-search rules. Platform and architecture names from Rust are converted by `nodePlatform()` for Node callers. Filesystem edge cases remain subject to native semantics documented in the guide.

Pseudo-terminals require a Unix daemon. Unsupported terminal requests fail on Windows. String command execution and direct argument-array execution remain distinct. Applications supply authentication, authorization, isolation policy, release binaries and any retry policy for operations whose outcome is unknown.
