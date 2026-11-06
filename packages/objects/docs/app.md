# App host

The `@axi/objects/app` entry assembles an Objects server and its worker processes. It supplies sessions, client pairing, files and data export. It does not supply a coding agent, model prompts or an application interface.

## Start a server

Call `startServer(options, context)`. Set these options:

| Option | Purpose |
| --- | --- |
| `name` | App identity and default data-directory name |
| `dataDir` | Private writable data directory; defaults to `~/.<name>` |
| `root` | Required directory containing application plugins; defaults to `plugins` |
| `api` | App module name, supported versions and module objects available to plugins |
| `kinds` | Node and browser facet kinds, with their allowed host packages |
| `principal` | Server principal and a function assigning each worker its principal |
| `workers` | Worker kinds, entry files, start data, authorization and idle policy |
| `listen` | Listening host and port; defaults to loopback with an allocated port |
| `base` | Additional source files or directories to watch for base-code changes |
| `timeouts` | Host close and ready timeouts, shared by the server and workers |
| `onError` | Receives host, HTTP, worker and plugin errors |

The principal union must include `{ kind: "owner" }`. Application rules decide which workers a caller may reach. The server's own principal may reach its workers for administration and export.

The returned `App` exposes the host, HTTP component, worker pools, plugin component and published client bundles. `AppInfo` reports the app name, API version and data directory. A worker exposes `WorkerInfo` with its address and application start data.

Use `applyChanges(context)` to build dirty plugins and roll the result through the server, workers and client surfaces. File watching marks changes; it does not apply them automatically. Failed plugin changes keep the prior working implementation. Concurrent calls run in order, including the build step.

The app watches files used by its worker and client bundles. A change sets `plugins.state.base`; it does not replace running base code. Additional `base` directories are watched recursively. The default host close timeout is 30 seconds; the ready timeout is 60 seconds.

Call `close(context)` at shutdown. It closes HTTP, workers, the host and Store before releasing the app lock. Repeated calls share the same close promise.

## Worker entry

Call `startWorker(options)` in each worker entry. Supply the app's API modules, facet kinds and error callback. The server starts the process on demand and sends its address, principal and start data.

The helper opens the worker's Store, connects it to the parent and loads its core and application facets. It adds `WorkerInfo`, `Files`, archive export and translations. If server telemetry is configured, it sends bounded telemetry batches to the server. The worker closes these resources when its lifecycle ends.

Application code chooses the worker's entry and principal. This helper does not isolate untrusted Node plugins.

## Data layout

```text
<dataDir>/
  owner-token
  server/
    cookie-secret
    store.sqlite
    files/
  workers/
    <kind>/
      <encoded address key>/
        store.sqlite
        files/
  plugins/
  logs/
```

Directories use mode `0700` and secrets and databases use `0600` where the platform supports those modes. The host refuses the home directory, filesystem root and a data directory owned by another user. A process lock prevents two servers from opening the same app data.

Worker keys are encoded for filesystem use. Keys whose encoded length exceeds 160 characters use a SHA-256 name. These directory names are an implementation detail; use `App.exportData` and `App.importData` to transfer an address.

SQLite may also create `-wal` and `-shm` files. They belong to the database. Do not delete or copy individual database files while the app is running.

## Sign-in and sessions

`ownerLink()` returns a URL whose fragment carries a single-use, ten-minute sign-in token. The default listener uses loopback. The sign-in page exchanges that token for a signed session cookie. The app also retains a reusable device token in `owner-token`; keep that file private.

`Sessions` issues, lists, verifies and revokes credentials. Stored browser and device sessions retain a secret hash, principal and usage times. Lists omit hashes. Sessions expire after 400 days without use. Cookies are renewed after a day of use. Revocation prevents later authentication with the credential.

An ephemeral session stays in memory. Its connection keeps it alive, followed by a 60-second reconnect grace period. It does not become a saved browser or device session. `ephemeralLoginFacet` lets a client choose a temporary name; it requires the app's principal union to include `EphemeralUser`.

Device pairing starts at `POST /_objects/pair`. The device shows a code. The owner compares and approves that code at `/_objects/pair/<code>`. The device polls for its token. Pending pairings expire after ten minutes and have global and per-address limits.

`inviteFacet()` adds owner-issued, single-use invitation links. An invitation expires after seven days. `defineUsers(profileSchema)` adds a persisted profile collection with typed update, lookup, list and remove operations. The app must enforce any additional user authorization rules.

## Files and archives

Import `Files`, `FilesFolder`, `filesFacet` and `copyFiles` from `@axi/objects/app/files`. This entry does not load the server or plugin compiler. The same names are available from `@axi/objects/app`. Server and worker startup install the files facet automatically. A standalone host installs `filesFacet(filesDirectory)` itself.

Each file belongs to a `space` at a `path`. Spaces contain 1 to 64 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit. Paths use `/` between names. Empty names, `.` and `..`, NUL characters and paths longer than 1,024 characters are invalid. An empty folder path selects the space's root.

`put({ space, path, mime, source, bytes, ... }, context)` returns `FileInfo`, including the version's permanent `id`. Writing the same path adds a version. Previous versions remain readable by ID. Optional `ref` identifies a producer's record; optional `key` makes a retried delivery return the committed file without storing another version. Optional `created` supplies an import timestamp. Optional `meta` stores JSON metadata; `null` is treated as absent.

Use these operations to inspect and organize files:

| Operation | Result |
| --- | --- |
| `file(id)` | A version by ID, or `null` |
| `get({ space, path, version? })` | The current or requested version, or `null` |
| `byKey({ space, key })` | A committed delivery, or `null` |
| `byRef({ space, ref, after?, limit? })` | Versions with that reference, oldest first |
| `versions({ space, path, after?, limit? })` | Versions at a path, newest first |
| `list({ space, folder, after?, limit? })` | Child folders followed by current child files, ordered by path |
| `mkdir({ space, path })` | Creates a folder and its missing parents |
| `move({ space, from, to })` | Moves a path and its versions or folder subtree without changing bytes |
| `copy({ id, space, path })` | Creates a version that shares the original blob |
| `remove(id)` | Deletes one version and promotes the previous version if needed |
| `removePath({ space, path })` | Deletes a file's versions or a folder subtree |
| `removeSpace(space)` | Deletes that space and its summary |

Pass `context` as the last argument. Paged results have `items` and an optional `next` cursor. Pass that cursor as `after`; the default page size is 100 and the maximum is 1,000. Version counters survive deletion and space removal. A copy has no delivery key. A move refuses an occupied destination or a destination inside its source.

For chunked writes, `begin(write, context)` returns `{ kind: "upload", upload }` or `{ kind: "exists", file }` for an already committed key. Repeating a pending key returns its existing upload. `append()` carries the expected byte offset, `uploaded()` returns the stored offset, `finish()` commits and returns `FileInfo`, and `cancel()` discards an unfinished upload. A failed write or one hour without activity removes an upload. A new host removes uploads left by an earlier process.

`put`, `append` and `read` accept at most 4 MiB per call. Defaults limit one file to 256 MiB and total stored or pending blob bytes to 4 GiB, with 64 uploads in progress. Shared copies count their blob once toward the total. `files` and `limits.uploads` configure these bounds in app options.

`Files.summary.get(space, context)` reports path count, version count, bytes across versions and the 20 newest versions. Acquire `FilesFolder` with `{ space, folder }` to follow its `listing`: up to 500 current entries and a `more` flag.

The host stores four index tables and summary documents in its Store. Immutable bytes live in `files/blobs/<blob id>`. Temporary uploads live in `files/.uploads/<run>/<upload>`. A file version ID is not its blob filename. Files contract version 2 does not migrate a version 1 file index.

`copyFiles({ store, files: filesDirectory }, targetDirectory, context)` copies only the file index and committed blobs into a new host directory. It holds the source Store's export queue while linking or copying blobs, stages beside the target, and removes staging data on failure. The target must not exist. Unfinished uploads and unrelated Store owners are excluded.

`exportData(address, path, context)` writes a tar archive containing a manifest, Store JSONL records and completed files. A running worker performs its export. Otherwise, the server acquires the worker's lock before reading its data.

`importData(archive, address, context)` accepts an empty destination only. It checks app identity, format, paths and limits, stages the contents, imports the Store and then installs the completed directory. Failure removes the staging directory. Defaults allow 100,000 entries and 4 GiB of unpacked data.

The Store archive is not a Durable JSONL session file. Durable has its own storage contract and can use an Objects Store through `StoreStorage`.

## Client connections

Pass `web` and `tui` options to publish client bundles. Clients connect to `/objects` using the app's authentication. See [Clients](clients.md) for browser startup, React bindings, terminal scopes and the trusted launcher. Client choice state is stored on the server; component page state remains local to its client host.
