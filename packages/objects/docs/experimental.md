# Experimental composition APIs

`@axi/objects/next` exposes versioned contracts, schema helpers, document and job declarations, protocol errors, observable sources, registries, links, and the shared Store. It also provides the object host, routed remote references, object-owned documents, routines, and persisted jobs. The main Objects runtime has a separate API.

## Contracts

Use `local()` for one set of members. Use `remote()` for named variants of state and methods. Each contract declares its version and parameter fields. `hostKind()` creates address constructors; it does not start or connect a host.

Schema helpers return TypeBox schemas. `obj()` rejects unknown fields. Method arguments must use closed objects, including nested objects. `bytes()` accepts a `Uint8Array` within its declared length bounds.

A declaration snapshots its schemas. Later changes to the application's schema objects do not alter the contract. A fingerprint identifies the contract's normalized shape. It does not depend on the contract name or version number and is not a security check.

`evolve()` appends a version through explicit member edits. Local contracts can change, add, or remove keyed members. Parameters and variant names remain fixed. A member keeps its kind throughout the history. Methods shared by variants must have the same signature. The editing callback must return its supplied editor.

`AcceptsTable` describes direct mappings from accepted older versions to the current version. Changed argument schemas need argument mappings. Changed results and state need mappings back to the old shape. Removed members need replacements or an explicit refusal. A no-op schema edit still requires its mapping.

Pass this table as `host.serve(type, factory, { accepts })`. Older local consumers read mapped state and keyed documents. Method calls map arguments to the current schema and results back to the caller's schema. State mappings are shared within an object attempt and consumer version. A refused state or keyed member prevents that older reference from becoming live.

A refused reference waits without holding an object or appearing in its presence list. A later publication can bind it again.

Method argument and result callbacks are captured when the provider binds. Replacing callbacks in the original table does not change an existing binding. Reload the provider to install new callbacks.

## Registries

`defineRegistry()` declares a name, version, contribution type and composed-value type. A declaration does not load plugins or compose contributions by itself.

`keyedEntries()` builds a map from a contribution table. The first contribution keeps a duplicate key, and the supplied callback receives the conflict. `orderedEntries()` combines list contributions and can sort them while preserving table order among equal items.

`RegistryValue` composes contributions, adapts accepted versions, and publishes changes through native watches and synchronous observers. Each contributor owns any native resources in its value. Durable's `registryReader()` adapts a registry value into the registry interface used by a Harness.

A cycle between registry contributions is detected when their values compose. The contribution that closes the cycle is excluded and reported as `contribution_failed`; the contributing object stays live.

## Observable state

`Batch` adopts related source changes together. Observers receive the committed values before the batch flushes its queued deliveries. Derives recompute from their dependencies and report failures through the same observation contract. Native sources carry values that do not need JSON encoding.

## Hosts and references

`createHost()` owns one object identity map, commit batch, registry table, and set of links. Give it an `onError` callback for background failures. An addressed host can serve remote objects when it also has a principal. A client can serve local objects.

`defineFacet()` groups synchronous declarations. Call `host.load()` once with named facets. It publishes their declarations together, then starts local objects with empty parameters. Loading waits for each such object's first outcome. A plugin whose setup or declarations fail is omitted and listed in the returned `failed` array. Other plugins continue loading. Background object failures go to `onError`.

`host.get()` waits for a live reference. `host.hold()` returns immediately. A reference reports `loading`, `live`, `failed`, or `ended`. Release it when its owner no longer needs it. Local objects with parameters and remote objects end after their final reference and running job, subject to their linger interval.

Factories use `self.get()` to declare dependencies. Activation waits for those dependencies without running another object factory inside a commit. Calls use `ctx.get()` for references that end when the call settles. `host.root()` gives application code the same scoped reference ownership and cancellation behavior. It uses the host's principal when the option is omitted. An explicit `{ principal: undefined }` creates an anonymous scope. Anonymous scopes can access local objects but cannot acquire remote objects.

`host.references()` reports presence by type. `host.activity` reports references, calls, jobs, and lingering objects. `host.close()` closes links, seals scopes and objects, drains admitted work, and closes native resources in reverse activation order. The application closes its Store afterward.

`host.reload()` replaces the complete facet set after loading. A facet passed again as the same object stays unchanged. Other facets are added, replaced, or removed. Reloads run in order.

The host stages new setup and factory declarations before publication. Staging opens no natives, binds no dependencies, and creates no documents. A failing plugin keeps its previous code, or stays absent if it was never loaded. Unchanged plugins reuse their declarations. Cancellation before publication preserves the complete installed set. Publication replaces the accepted providers and facet contributions in one batch.

A changed consumer also keeps its previous code when its recorded requests require an incompatible provider whose update failed. The check repeats until no further plugin needs to stay unchanged. Requests to another host follow that host's rollout. Without a failed plugin, an unavailable dependency remains an ordinary wait.

An object with no native resources swaps code while keeping its documents and identity. Existing calls finish on the previous code. A native resource or table migration requires a restart: calls drain, natives close with reason `reload`, and the replacement activates. Failed or parked objects retry. Removing a type ends its objects and leaves held references waiting for the type to return.

References own their last visible state and keyed pins. They keep these values while a type is absent, a version is refused, or a replacement opens. Once a compatible instance becomes live, existing watches follow its members. A reference that never received values waits for its first compatible instance. Release or watch cancellation releases its pins.

The returned report lists added, changed, removed, and failed plugins and each affected object's outcome: `swapped`, `restarted`, `ended`, `retried`, or `parked`. A restart report does not wait for native resources to reopen. Watch the reference's state for readiness. An abort after publication rejects with `aborted` and `details.committed`, which lists the plugin changes that still took effect.

The optional [Node plugin component](plugins.md) discovers, builds, evaluates, watches, and reloads plugin directories. It stays separate from this portable host. The application chooses the rollout order across hosts.

## Routing and recovery

`host.accept()` receives a child connection and stamps its principal. `host.connect()` sets the parent connection. After a disconnect, the application supplies a new parent link. Existing references bind again and keep their last snapshots while loading. Calls already sent fail; they are never automatically replayed. Calls waiting on a loading reference have a bounded deadline.

`host.route()` registers address authorization and link resolution before loading and returns `retry(address)` and `suspend(address)` controls. Each address resolves at most once at a time. Failed resolution leaves holders waiting with its error. A new hold, explicit retry, or the loss of an established link can start another attempt. There is no timer retry. Suspension lasts until retry or the final holder releases the address.

Relays forward opaque parts and keep separate call and state windows for each origin. Only parent and route links accept origin fields. A child link carrying one is refused. An origin's provider record ends when it has no holds, calls or unacknowledged state.

The internal Node [HTTP component](http.md) serves contributed routes and WebSockets. The [worker component](workers.md) starts process hosts on demand and ships plugin updates to them. These components do not add package exports.

A child cannot choose its caller identity. Only a parent can supply the principal and incarnation on an arriving hold. Revocation ends affected objects and references and travels over route links. This host's own principal and its parent link remain outside that revocation.

## Links

`memoryLinkPair()` creates two connected in-process endpoints. IPC and WebSocket adapters carry byte messages between endpoints. A link provides delivery and close notifications. It does not create object references or route calls by itself.

The internal channel performs a versioned handshake before sending queued work. It checks incoming message envelopes, answers heartbeat messages, and processes messages in order. A handler that returns a promise holds later messages until it settles. A malformed message closes the channel.

A state change queued in a batch is dropped if its hold leaves the binding before the batch flushes.

The binary codec keeps received JSON parts opaque and carries payload byte segments as views of the received packet. The text codec uses JSON tuples and is useful when inspecting a link. A compressed part can pass through either codec without being inflated.

## Documents and jobs

`defineState()` declares a document schema, version, initial value and optional persistence policy. A keyed declaration addresses multiple documents by key. `defineJob()` declares a job's argument and result schemas, state, concurrency limit and recovery policy. These declarations do not start work themselves.

The internal document owner serializes transactions on one object. A transaction stages document and table changes together. It adopts them only after the Store commits. Ending an attempt fences its transactions, including work queued behind another Store commit. Document handles remain versioned across attempts.

The internal job runner stores unsettled runs separately from their state documents. It reserves a persisted run before invoking application code, records its outcome, and runs its finish callback in a transaction. A successful finish removes the record and retires its state. Failed finishes retry with backoff and block after five failures.

A deferred job-state change becomes observable immediately and is stored by its deadline or an earlier immediate write. The outcome and close writer also flush deferred state. A crash can lose deferred changes. A state change that resets a run's restart count is immediate.

Across a pure swap, an active job invocation finishes with the implementation and arguments it started with. The replacement runs its finish callback. A job's `accepts` table maps older arguments and results to the current version. A run without a compatible definition stays blocked until a later reload supplies one. Reload also retries blocked finish callbacks. A native restart interrupts active in-memory runs with reason `reload` and finishes them on the replacement.

When compatible code returns, a saved finish receives its restored state and starts with a fresh finish-failure count. If an argument adapter throws, the running list keeps the original arguments visible while finish retries handle the error.

An active invocation keeps its original state schema and checkpoint policy. Its deferred writes retain that version. The replacement reads the state through the current migration.

Factories declare these components through `Self` and `StoreSelf`. Persisted state, tables, contributions, and persisted jobs require a local object with empty parameters and an attached Store. The main and experimental host APIs are separate contracts.

## Shared Store

`openStore(sqliteBackend(database), context, options)` opens one Store over a SQLite database. The Store owns the database after opening. Node SQLite and SQLite-backed Durable Objects use the same database contract.

The Store serializes commits and assigns one sequence to each nonempty commit. A commit applies all staged writes in one SQL transaction. Adoption runs after the database commits and before the next queued commit. A rejected transaction leaves the Store usable when rollback succeeds. An uncertain database outcome stops the Store.

`defineTable()` declares columns, a primary key, indexes, and a version. `evolveTable()` records later versions and their data transformations. Migration processes rows in bounded chunks and stamps completed rows so interrupted work can resume. `query()` builds immutable conditions and ordering. Page cursors identify their table and ordering.

The document engine stores live and retired records with base values and subsequent deltas. Each record chooses `none`, `latest`, or `rewindable` history. Addresses have one current incarnation. Historical reads respect the interval from creation up to retirement.

The optional outbox records each commit's applied writes and allocation position. Reads and trims run in order. `applyBatch()` replays consecutive commits when no owner holds claims on the Store. A mismatch in recorded row counts stops later replay.

`store.export(context)` holds the commit queue while it yields a manifest, table records, rows, document history, and an end count. Ending or cancelling the iterator releases the queue. `importStore()` validates the archive and applies it atomically to an empty database. `encodeJsonl()` and `decodeJsonl()` encode these archive parts as UTF-8 lines.

`@axi/durable/storage/store` uses this Store through `StoreStorage`. An adapter owns its table and document claims. Closing an adapter releases those claims; the application closes the Store itself.

## Errors

`ObjectsError` carries a protocol code, its permitted reason, a message and optional JSON details. Its JSON representation excludes the stack and cause. `PluginError` carries an application's own error code and details. `broken()` marks a configuration failure that automatic retries cannot repair.

Experimental errors use their own constructor contract. Import them from `@axi/objects/next` when using these APIs.
