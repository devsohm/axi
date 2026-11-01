# Environment wire protocol

The daemon implements protocol 1 over stdin and stdout. Its command is `axi-env serve --token <hex>`. Diagnostics go to stderr.

## Connection startup

The daemon writes `AXI-ENV <token>\n` before any frame. The client discards earlier bytes, including output from shell startup files.

The first request is `hello` with `{ protocol: 1 }`. Its result contains `protocol`, `version`, `os`, `arch`, `home`, `tmpdir`, `separator`, `cwd`, `driveCwds`, `pid` and `features`. The version is the environment package version. OS and architecture names use Rust spelling. `nodePlatform()` converts known names to Node spelling. Windows `driveCwds` contains working directories for drive-relative paths.

`features` currently includes `listFiles`. A client checks this list before requesting an operation added after the initial protocol release.

## Frame layout

All integers use big-endian byte order.

| Field | Size | Value |
|---|---|---|
| Length | 4 bytes | Number of bytes following this field |
| Type | 1 byte | Frame type |
| ID | 4 bytes | Request ID, or zero for an independent frame |
| JSON length | 4 bytes | Size of the JSON field in bytes |
| JSON | Variable | UTF-8 JSON object |
| Payload | Remaining bytes | Binary data |

The length is between 9 bytes and 16 MiB. The JSON field cannot extend past the frame. Invalid framing ends the connection. An invalid request JSON field receives an `EINVAL` error.

| Type | Name | Meaning |
|---|---|---|
| 1 | Request | Client operation named by `op` |
| 2 | Result | Successful completion of the matching request |
| 3 | Error | Failed completion of the matching request |
| 4 | Event | Progress without completing the request |
| 5 | Cancel | Cancellation of the matching request |
| 6 | Ping | Liveness frame, ignored by its recipient |

Errors contain `code` and `message`, with optional `syscall` and `path`. File codes use Node error names. Execution can also return `shell_unavailable`, `spawn_error`, `timeout`, `aborted` or `unknown`. Messages are diagnostic text.

Paths are absolute strings. The client resolves relative paths, home expansion and file URLs. Encoding replaces lone surrogates with U+FFFD. File content remains binary.

## Scheduling and lifetime

The daemon registers a request before running it, so a following cancel cannot overtake registration. File operations use 16 worker threads. Commands, terminals and watchers each use a separate thread. Writes to one open file handle run in arrival order. Terminal input, resize and foreground queries are dispatched in arrival order.

Control replies precede queued output. Command results follow command output. Replies with more than 64 KiB of payload also use the output queue. Unwindowed output waits when more than 4 MiB is pending.

Both sides send a ping every five seconds. After 30 seconds without incoming bytes, the daemon kills its process groups and exits. EOF also triggers cleanup. The client rejects requests from a lost connection with `code: "unknown"` and `lost: true`. A later operation starts a new daemon. File and terminal handles remain tied to the session that created them.

A cancel kills an `exec` or `pty` process group and returns `aborted`. A cancel with `{ mode: "kill" }` kills without marking the request aborted. Line scans and tree listings check cancellation between chunks or entries. A cancelled watch completes with `{}`. Short file operations finish normally.

## Files

File operations return `{}` unless the table specifies another result. Paths use `path`.

| Operation | Other fields | Result or behavior |
|---|---|---|
| `lstat` | None | File information |
| `realpath` | None | `{ path }` |
| `write` | `append`, optional `parents` and `keep`, payload | Creates parents by default. `keep` returns `{ handle }`. |
| `writeChunk` | `handle`, payload | Writes to a kept file. A previous failed write causes `EBADF`. |
| `truncate` | `size` | Changes file length |
| `fsync` | None | Flushes the file |
| `rename` | `to` | Renames the path |
| `mkdir` | `recursive` | Creates a directory |
| `rm` | `recursive`, `force` | Removes the path |
| `mkdtemp` | Prefix in `path` | `{ path }` |
| `open` | `noFollow`, optional `mode` | `{ handle, info }` for a nonblocking regular-file reader. `mode: "read"` opens any file like Node `open(path, "r")` and returns `stat` or `statError`. |
| `pread` | `handle`, `length`, optional `offset` | Payload bytes. Without an offset, reads at the current position. |
| `fstat` | `handle` | File information |
| `scanLines` | `handle`, `startLine`, optional `endLine` | `LineScan` |
| `opendir` | None | `{ handle }` |
| `readdir` | `handle`, `max` | `{ entries, done }` |
| `close` | `handle` | Releases a handle |

File information contains `name`, `kind`, `size`, `mtimeSec`, `mtimeNsec`, `dev` and `ino`. Kinds are `file`, `directory`, `symlink` and `other`. Directory entries contain `name` and either `info` or `error`. Optional `raw` bytes preserve invalid UTF-8 names for sorting. The session supports at most 4,096 handles.

`listFiles` takes these options:

| Option | Default | Meaning |
|---|---|---|
| `path` | Required | Directory to list |
| `hidden` | `true` | Includes hidden names |
| `gitignore` | `true` | Applies ignore rules inside Git work trees |
| `exclude` | Empty | Names to omit with their descendants |
| `maxEntries` | 50,000 | Entry limit |
| `maxBytes` | 4 MiB | Payload limit, capped at 16 MiB minus 64 KiB |
| `timeoutMs` | 10,000 | Time limit |

The result is `{ count, truncated }`. Each payload record contains a kind byte, a relative UTF-8 path and NUL. Kind bytes are `f`, `d` and `l`. Paths use `/`. Traversal is depth first with siblings sorted by name bytes. Links are listed without following them. `.git` is always excluded. Unreadable entries are skipped. A missing root returns `ENOENT`, and a file root returns `ENOTDIR`.

## Commands

`exec` accepts `command` or `argv`, `cwd`, `env`, `inheritEnv` and optional `shellPath`, `timeoutMs`, `spill` and `window`.

Output events contain `{ kind: "output", stream, skipped? }` with decoded UTF-8 text in the payload. A window contains `maxBytes`, `maxLines`, `minIntervalMs` and `bytesPerSecond`. The daemon can omit output outside that window. `skipped` records omitted bytes, newline count and whether the omitted text ends with a newline.

Successful execution returns `{ exitCode, spillPath? }`. Timeout and abort errors can also carry `spillPath`.

## Watches

`watch` accepts `targets` and optional `mode`, `pollIntervalMs` and `maxDirectories`. Each target contains `path`, `recursive` and `exclude: { hidden, names }`.

Coverage starts with `{ kind: "ready", mode }`. Later events contain `{ kind: "change", paths }`, an overflow event, or `{ kind: "error", code, message }`. Native-watch failure switches to polling and reports overflow. An error ends delivery. The request remains active until cancelled.

## Terminals

`pty` accepts `cwd`, `env`, `inheritEnv`, `cols`, `rows` and optional `argv`. Rows and columns are between 1 and 4,096. Without `argv`, the program is a login shell from `SHELL` or `/bin/sh`.

The first event is `{ kind: "started", pid }`. Output events contain `{ kind: "output" }` and raw payload bytes. The result is `{ exitCode }`. Output drains until the terminal closes or remains idle for 100 milliseconds after the program exits. Windows returns `ENOTSUP`.

`ptyWrite { target }` sends payload bytes to the active terminal. `ptyResize { target, cols, rows }` changes its cell size. Both return `{}`. `ptyForeground { target }` returns `{ foreground: { pid, name } }` for a foreground job, or `{ foreground: null }` for the terminal's own program. An unknown process name is `null`. Operations on an ended terminal return `EBADF`.
