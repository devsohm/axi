# Environment semantics

`RemoteExecutionEnv` implements Durable's `ExecutionEnv` on the machine running the daemon. `LocalExecutionEnv` uses `NodeExecutionEnv` for ordinary operations and the local daemon for `listFiles`. The caller owns the connection.

## Paths and errors

The client uses the remote system's path rules. Relative paths resolve against the environment's `cwd`. `~` uses the remote home. File URLs are decoded when valid. Windows drive-relative paths also use the daemon's per-drive working directories.

File methods return `Result` values. Common remote codes map as follows:

| Remote code | `FileError.code` |
|---|---|
| `ENOENT` | `not_found` |
| `EACCES`, `EPERM` | `permission_denied` |
| `ENOTDIR` | `not_directory` |
| `EISDIR` | `is_directory` |
| `EINVAL`, `SYMLINK`, `NOT_REGULAR` | `invalid` |
| `aborted` | `aborted` |
| Other codes | `unknown` |

Error messages may vary by operating system. A lost connection does not establish whether an in-flight mutation happened. Handles from the lost session cannot be used in its replacement.

## Files and directories

Recursive directory creation accepts an existing directory. An existing file returns `EEXIST`, and a file in a parent position returns `ENOTDIR`. File writes create missing parents.

Removal of a missing path requires `force`. Removing a directory requires `recursive`. Without it, the remote `ERR_FS_EISDIR` code maps to `unknown`.

Temporary directories use the remote temporary directory and the supplied prefix. The default prefix is `tmp-`. Prefix joining permits parent components. On Unix, the remote temporary directory follows `TMPDIR`, `TMP`, `TEMP`, then the platform default. Termux uses `$PREFIX/tmp`. Windows checks `TEMP`, then `TMP`, then the system directory's `Temp` folder.

`listDir()` uses byte order on POSIX and the file system's order on Windows. An entry that cannot be inspected fails the listing. A directory reader retains enumeration order, skips vanished entries and fills the page after those skips.

`listFiles()` returns a bounded tree of files, directories and links. It does not follow links. Git ignore rules can omit tracked files too. Its defaults and payload are documented in the [wire protocol](protocol.md).

A binary reader opens a regular file without blocking. Directories return `is_directory`. Other special files return `invalid`. `noFollow` refuses a final symbolic link.

Whole-file reads and line readers use an ordinary read-only open. Devices can return an empty result. A FIFO can wait for a writer. A directory fails when read. Regular-file reads use the size observed at open. Other files are read until EOF.

`readBinaryFile()` returns a Buffer. Binary reader chunks are plain Uint8Array values. Text file decoding preserves a leading byte-order mark. Line readers use Durable's `StreamDecoder` and report whether each line ended with a newline.

Writes use chunks of at most 512 KiB. `writeFile()` checks cancellation before subsequent chunks. `appendFile()` completes its writes before the final cancellation check. Cancellation is also checked before either operation starts.

Windows removes a directory symlink or junction itself. A file cannot replace a directory through a normal write. Modification times can precede 1970.

## Commands

A string command runs through a shell. A configured missing shell returns `shell_unavailable`. Otherwise Unix selects `/bin/bash`, a Bash found on `PATH`, or `sh`. Windows string commands use Git Bash. An argument array starts the program directly. Windows direct execution searches the working directory and `PATH` with executable suffixes and refuses batch files.

The working directory must exist. `inheritEnv` defaults to `true`. The daemon environment is then combined with the environment's `shellEnv` and the request's `env`. With inheritance disabled, only the request environment is used.

Timeouts are positive, finite seconds, with a maximum of 2,147,483.647 seconds. An already aborted context returns `aborted` before execution options are read.

On Unix, each command owns a new process group with reset signals. Timeout, abort and environment cleanup kill that group. A signal exit code is 128 plus the signal number. Aborting returns `aborted`. Cleanup kills without marking the request aborted, so a killed command can return exit code 137.

After the program exits, output drains until both pipes end or remain idle for 100 milliseconds. The timeout still applies during that drain. Each output stream has its own UTF-8 decoder, which removes only an initial byte-order mark.

An output callback failure takes precedence over execution errors. Timeout takes precedence over abort, followed by spill failure and the exit result. A spill starts after either configured raw-byte or line threshold is crossed. The file contains complete raw output and uses `axi-output-<uuid>.log` inside a fresh temporary directory.

## Watches and terminals

Native notifications trigger a debounced snapshot comparison. Reads do not produce file-change events. Windows and file systems without dependable native notifications use polling. Exhausted native watches cause polling and an overflow report.

A watcher reopens after connection loss and reports overflow because changes during the gap are unknown. Reconnect delays start at one second and double to a maximum of 30 seconds. Polling defaults to two seconds. A watcher covers at most 10,000 directories by default.

Terminals pass raw bytes, accept ordered input and expose resize and foreground-job queries. They require a Unix daemon. Closing a terminal cancels its process group. Environment cleanup leaves the shared connection open.
