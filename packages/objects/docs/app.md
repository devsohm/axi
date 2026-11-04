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
| `onError` | Receives host, HTTP, worker and plugin errors |

The principal union must include `{ kind: "owner" }`. Application rules decide which workers a caller may reach. The server's own principal may reach its workers for administration and export.

The returned `App` exposes the host, HTTP component, worker pools, plugin component and published client bundles. `AppInfo` reports the app name, API version and data directory. A worker exposes `WorkerInfo` with its address and application start data.

Use `applyChanges(context)` to build dirty plugins and roll the result through the server, workers and client surfaces. File watching marks changes; it does not apply them automatically. Failed plugin changes keep the prior working implementation.

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

`Files` supports whole-file writes and incremental uploads. Appends carry an expected byte offset. `finish()` makes an upload visible as a completed file. Expired or failed uploads are removed. Defaults limit one file to 256 MiB and all completed files to 4 GiB; `files` and `limits.uploads` configure these bounds.

`exportData(address, path, context)` writes a tar archive containing a manifest, Store JSONL records and completed files. A running worker performs its export. Otherwise, the server acquires the worker's lock before reading its data.

`importData(archive, address, context)` accepts an empty destination only. It checks app identity, format, paths and limits, stages the contents, imports the Store and then installs the completed directory. Failure removes the staging directory. Defaults allow 100,000 entries and 4 GiB of unpacked data.

The Store archive is not a Durable JSONL session file. Durable has its own storage contract and can use an Objects Store through `StoreStorage`.

## Client connections

Pass `web` and `tui` options to publish client bundles. Clients connect to `/objects` using the app's authentication. See [Clients](clients.md) for browser startup, React bindings, terminal scopes and the trusted launcher. Client choice state is stored on the server; component page state remains local to its client host.
