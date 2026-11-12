# Objects specification

## JSON revisions

The [JSON revision contract](delta.md) defines draft ownership, preparation, replay and streaming. Published revisions and operations are immutable by contract. Object copies preserve plain and null prototypes, own data properties and unchanged nested values.

## Identity and declarations

Object identity consists of contract, canonical parameters and principal. Parameters are required and cannot declare defaults. Contract declarations own immutable schema snapshots and fingerprints. Equal versions require compatible fingerprints. Accepted older versions use explicit adapters. Schema `format` fields describe values without validating their format; constraints such as `pattern` still apply.

Version validation and retained metadata use the same selected value. A remote contract retains the host-address function it validated.

`bytes()` returns a plain `{ type: "bytes", minLength?, maxLength? }` marker. Contract validation checks `Uint8Array` values and their byte lengths without adding executable properties to that marker. Invalid arguments report their JSON Pointer path, the expected type and the received type. Missing and unknown fields report their own paths.

Constraint failures explain the limit or allowed values. A union uses its distinct constant tag when available; otherwise it selects the branch declaring most of the supplied fields, then the branch with the deepest first failure. Fragment references resolve within their schema resource. Compiling a missing fragment target fails.

A local contract has one member set. A remote contract has named variants and a host-address function. Placement cannot be overridden by a request. Method arguments and results are checked at dispatch, including local calls. Factories declare synchronously and return an implementation rather than a promise.

Host address keys encode the kind and parameter values in declaration order. Separators and backslashes in values are escaped. Key conversion checks field types and enum choices and computes the key from parameters, rather than trusting a supplied key. Routing checks the remaining parameter constraints. Stored keys decode numeric and boolean fields to their declared types.

## Events

An event member sends transient JSON values. Declare one with `event(schema)` in a local contract, or in a remote variant's `events` map. Its implementation is a source from `self.events<T>()`, or an event member obtained through that object's reference. Byte schemas are refused.

`emit(value)` records a timestamp immediately and queues delivery in a microtask. Events are delivered in emission order, then subscription order. An emission is independent of a transaction: rollback does not retract it. Events have no stored history and are never replayed. An ended attempt refuses further emissions.

`member.on(listener, context)` returns a subscription with `stop()`. Cancellation, reference release or a throwing listener ends that subscription. A listener failure is reported without stopping other listeners. A subscription follows its reference when an implementation reloads. Events emitted while no eligible binding exists are lost. Re-exposed members preserve the original value and timestamp.

Changing an event schema requires an explicit older-version mapping, including an edit that retains the same schema. A mapping failure drops that version's event and reports once until the mapping succeeds again.

## Host lifecycle

`load()` runs once. Local acquisition before loading fails with `not_ready`. Loading publishes accepted declarations together and starts empty-parameter local objects. Its report waits for their first outcome. Failed setup excludes that plugin. Invalid plugin names reject before host state changes.

References report `loading`, `live`, `failed` or `ended`. Their released ownership cannot be reused. Object-owned dependencies remain through an attempt. Call-owned references end with their call context. Root contexts use the host principal by default. An explicit undefined principal creates an anonymous scope.

A removed provider leaves existing keyed-document watches open at their last value and sends one failure notification. They follow the provider again when it returns. Releasing a reference publishes failures to any derives that still follow its members.

`RegistryValue.observe(observer, context)` takes the current value and attaches synchronously. It selects the context's cancellation signal once. That signal ends the attachment with `aborted`; a closed source ends it with `ended`. Calling `detach()` removes the observer without an end callback.

Dependencies can park activation without consuming its readiness deadline. Transient activation failures retry with backoff. Broken failures wait for an explicit retry or replacement. Native resources close in reverse order. A late opener is closed if its attempt already ended.

Host close stops new work, closes links, seals scopes and objects, drains admitted calls and closes resources. Cleanup continues after individual close failures. The application closes the Store separately.

## Publication and storage

Transactions serialize changes to one object's documents. Store commits order writes across owners. A transaction publishes no draft before storage adoption. Document changes, table changes and live-query refreshes publish in one batch. A failed refresh keeps the last live rows and reports its failure once per episode.

Commits queued behind a running Store step share the next database transaction. Each retains its own sequence, outbox record and adoption. Metadata is written once per group. If a member's writes refuse, the group rolls back and runs its admitted members individually. A failed transaction boundary stops the Store instead of retrying an uncertain outcome.

`store.onCommitted(listener, onError)` reports the latest adopted sequence in a microtask. Commits adopted before that notification share one call. Empty work and refused writes produce no notification. The returned function removes the listener. A throwing listener is removed and its error reaches `onError`; stored commits remain intact. Applied remote history produces the same notification.

Persisted state declares a schema version and checkpoint policy. A schema change requires a compatible migration. Tables record version history and bounded migrations. Jobs persist unsettled run records separately from their state. Recovery uses committed records, not unfinished in-memory callbacks.

Table declarations capture their version, columns, key and indexes before validation. The row codec, schema metadata and fingerprint use those captured values. Store startup selects its outbox setting once. A failed read selects one cancellation signal to distinguish caller cancellation from a backend failure.

`keyed: Kind` declares documents keyed by addresses of a declared host kind. Handles and local contract members accept addresses and list decoded addresses. Keys are recomputed from the address parameters. Strings, wrong kinds, and omitted keys are refused. A persisted record belongs to its key's host; plain string-keyed records belong to none. Changing between these forms requires explicit data conversion. Reload refuses a declaration with a different key kind. A contract's fingerprint includes its key kind; an older consumer can only refuse a rekeyed member, because a value adapter cannot translate its keys.

`host(Kind)` declares a table column containing addresses of one host kind. The Store writes canonical address keys as text and returns addresses on reads. A table has at most one host column. It cannot be optional or have a default. Its automatic `host` index is omitted when the primary key already starts with that column. Host columns support equality, inequality, and membership conditions. Ordering comparisons, prefix conditions, null conditions, and expressions over host addresses are refused.

Store schema version 3 adds an optional, indexed host field to document records. Existing records keep no host owner. A string key matching a host address does not make the record host-owned. Table records and archives retain host-column kinds. Schema migration preserves existing document values and lifetimes.

`exportHostData()` selects one address's live documents and table rows. Its archive uses the Store format with a host key in the manifest. `readHostArchive()` validates ordering, ownership, revision chains and the end count. Import and delete run through the Host, which coordinates live owners. Import refuses existing data by default; `existing: "replace"` replaces it in one commit. Copying to another address of the same kind rewrites ownership keys, without rewriting addresses inside JSON values. Row-key collisions with another address are refused. Older rows require their owner's declared table history; row and JSON-cell versions are preserved through migration.

Host data operations run in call order. Their exclusive phase waits for activation loads, blocks later loads and takes affected owners' document lines in identity order. It reads the new documents and query results inside the storage transaction, then publishes them together after commit. An unreadable document fails its owner after that batch; other owners still adopt. Cancellation before admission writes nothing. Once admitted, an operation completes and publishes even if its caller cancels.

An import selects its collision policy after parsing the archive and before entering the operation queue. Changing the caller's options while it waits cannot turn a refused collision into a replacement.

An uncertain database outcome is terminal for the Store. Export holds its queue until the iterator ends or is cancelled. Import validates and applies the complete archive to an empty database. Optional outbox replay accepts consecutive commits and checks row counts.

## Store sync

The experimental sync API uploads committed outbox records in ordered batches. A remote slot records the preceding sequence, final sequence and writer identity. Existing slots are immutable. A retry by the same writer can adopt its previously accepted slot. A slot from another writer reports divergence. Backends that enforce writer epochs can reject stale writers.

Pull saves a target sequence before applying a batch. After interruption, that marker distinguishes the applied prefix from new local work. Pull refuses unsynced local commits. Archives restore only into an empty backend. Snapshot folding preserves slot ownership after removing old batch bodies.

Filesystem metadata writes serialize the supplied object before starting asynchronous file operations. A serialization failure rejects the write's promise and creates no session directory.

Batch bodies are gzip streams of version 2 JSON lines. Snapshot bodies compress the existing Store archive format. Upload targets 8 MiB batches. Pull applies about 4 MiB per transaction. A single large record can exceed either target. The filesystem remote supports one writer process and does not enforce epochs. See [Store sync](sync.md).

## Reload

Reload applies a complete facet set. Identical facet objects remain installed. Staging runs no native open or job. Failed plugins retain previous code. Dependency checks preserve a changed consumer's prior code when its required provider update failed.

Publication replaces accepted providers and contributions in one batch. Every affected live object restarts while retaining its documents and tables. Removed types leave held references waiting. Reports retain declaration order. Failed, waiting and activating objects retry on the new code.

Reloads serialize. Cancellation before publication leaves the prior set intact. Cancellation after publication does not undo the accepted update. Error details identify committed plugin changes.

A reload report describes the first dependency check. An initializer failure is an activation failure, not a parked dependency. A blocked key load keeps its long-wait diagnostic active until the wait ends. Removing an object wakes calls waiting behind its outgoing work immediately.

An outgoing attempt remains open for calls already running and calls they cause. New calls wait for the successor. Compatible references can read outgoing state until its attempt seals. A restart waits for its recorded dependencies and for outgoing calls to finish. Readiness references do not appear in presence lists and remain held until the successor checks its own dependencies.

`reloadDrainTimeout` bounds this wait. Its default is 5,000 ms, capped by `closeTimeout`. A timed-out call rejects with `released`, and the host reports `drain_timeout`. Native resources close with reason `reload`. In-memory job runs end with an aborted reload outcome; persisted jobs recover according to their definition. An old call waiting through dependencies or openers on its own reload drain fails with `unavailable/reload_cycle`.

Trusted links propagate outgoing-call ancestry through `call.old`. Untrusted links cannot claim it. Readiness waits through remote version skew until the other host updates or the deadline expires. Local dependency failures report `parked` with their cause. The replacement factory runs after the old attempt closes. Non-native contributions remain until the replacement publishes; native contributions leave at the seal.

An outgoing call captures its ancestry before waiting for a send slot. A reload during that wait does not reclassify the queued call.

## Links and authority

Links handshake before queued work. Untrusted envelopes are validated. Malformed messages, duplicate identifiers and control traffic from an unauthorized role close the channel. Asynchronous handling holds later messages until it completes.

Hold encoding captures one address and principal before writing their fields. Trace carriers are encoded only on holds and calls. Codecs frame messages; the receiving channel checks the envelope schema.

Only parent links can stamp principals and incarnations. Routes authorize each hold before resolution. Revocation ends matching external objects, unbound work and downstream links. The host's own principal is exempt.

Each origin has independent call and state windows. Two unacknowledged local state messages fill the state window. Method replies and control messages remain independent. Remote views keep their last snapshot while disconnected. Sent calls fail on loss and are never replayed automatically.

An untrusted link admits up to `callWindow` outstanding calls, default 10,000. Trusted links have no call-window limit. Events have a separate per-origin window, default 32 messages. A full event window drops new events before encoding. Event acknowledgements do not release state credit. A relay returns event credit only when its downstream consumer acknowledges delivery.

Before a result or error is sent, the answering host sends that origin's pending state, even when the ordinary state window is full. A relay sends its own pending state before forwarding an answer. These extra state messages use the same ordered acknowledgements. The guarantee covers changes committed by those answering hosts before the answer, not effects left running after it.

A plugin error sends its code, message and optional JSON details. Those fields are read once when the error is encoded. Its stack and cause stay on the answering host.

A loading transition during reload preserves admitted calls. Calls that crossed the transition use the previous method names until the consumer acknowledges the new binding. Failure, removal, cancellation and link loss still end affected calls.

Default heartbeat settings ping after 15 seconds and close after 30 seconds. A delayed local timer does not count a sleeping process as peer silence. Type names and host kinds are bounded to 256 characters on the wire. Trace carriers have at most eight printable entries of bounded length.

## Jobs and routines

A routine serializes its calls and coalesces source changes during a call. It waits on a failed source until values return. Failed routines retry with backoff. Ending the attempt cancels their contexts and joins admitted work.

A job runs outside its finish transaction. Its successful finish commits cleanup and application changes together. Five finish failures block further tries. A reload can retry a blocked finish. Persisted runs recover their saved arguments, progress and supported trace carrier. Deferred state may be lost before its persistence deadline. Applications own external-effect idempotency.

Job declaration checks read the resume policy once after checking its keys. Version-adapter functions can be non-enumerable properties; their values must still be functions.

Job start setup failures reject the returned promise. A traced start keeps its selected telemetry parent. State-change validation reads a deferred persistence deadline once before admitting the change.

The finish span stays open until the final blocked state is committed and published.

Finishing an older completed run maps its arguments and result before migrating the state passed to the new finish callback.

Resuming a blocked run increases the host's active-job count in the same committed batch that publishes the resumed entry.

## Node helpers

Plugin roots may be required or optional. Discovery reports collisions and invalid entries. Builds restrict imports to permitted plugin, shared and host-package paths. Plugin scripts execute as trusted code. File watching marks changes without applying them. Rollouts ship built generations through ordered host steps. Workers evaluate prebuilt scripts without rebuilding them.

A kind name before a file's extension restricts its imports to that facet kind. An extensionless shared file does not acquire a kind from its basename.

Initial plugin loading passes every prepared facet to the host for name validation. The loaded-set cache does not hide duplicate names.

Package installation accepts both npm's array pack result and its package-name-keyed result. Plugin stack maps are decoded only when an error frame needs them. Worker bundles store source maps beside their modules. Worker processes use the caller's `execArgv`; add `--enable-source-maps` explicitly for mapped worker stacks, with its parsing and memory cost.

HTTP routes deny anonymous callers unless explicitly public. Cross-site routes are public and anonymous. Authentication, host, origin, header and response-body checks run at the request boundary. Resource and root scopes last through response completion or cancellation.

The HTTP component selects its listening address at construction. Replacing the caller's `listen` option before host startup does not change that selection.

Worker starts serialize per address and hold process locks. Stale file locks are cleared only when no process is listening. A missing child PID is never a signal target. A running worker's lost link permits one recovery per minute for its address. Another loss within that window, a crash or a failed start requires retry or rollout.

## App host and clients

The app host opens one server Store and one Store per worker address. Startup holds a data-directory lock. Closing the app releases that lock after its components close. Persistent device and browser sessions store hashes rather than token secrets. Ephemeral sessions and pending sign-in links remain in memory.

The app chooses `principal.owner`, which must be strict JSON and differ from the server principal. Sign-in, pairing and invites use this value. `AppInfo` version 2 exposes it. Owner comparison uses cached canonical principal keys. Changing the owner revokes the token-file session and replaces that file, leaving other sessions unchanged. Worker kinds require a worker-principal function.

The listener starts before worker and client base builds. Shared builds publish once. `basesBuilt` waits for build outcomes; `baseWatched` also waits for their initial source comparisons and the deferred server-entry scan. Failed builds report `base_build` without stopping the server. Affected client routes return 503; affected workers fail before requesting application start data. Closing discards late background results without waiting for blocked builds or scans.

Base bundles record input hashes at the read that supplies the compiler. The restart flag compares current contents with every running base record and clears after a revert. New source files inside configured base directories set the flag. The server records its entry's static graph when possible; unresolved imports are omitted, while other scan errors report `server_scan`. Server files changed since process startup retain a restart mark until restart. Browser and terminal bundles inherit the server's resolution conditions unless overridden. Worker output files are written at first fork and retained until the last child exits. Application cache directories hold worker outputs and Node's compile cache.

Files contract version 2 stores immutable file versions by space and path. Index mutations serialize per Files object and commit version rows, path counters, blob reference counts and summaries together. Deleting data retains path counters. Moves preserve version identities; copies share blobs without carrying delivery keys. Folder views attach without missing intervening changes and refresh once per affected watched folder. File-only copies export the Files owner's tables and documents while retaining referenced blobs. The previous file index has no automatic migration. See [App host](app.md#files-and-archives).

An address export holds its worker's data through the worker or its process lock. Import requires a new destination, validates archive paths and limits, and publishes the staged directory only after Store import succeeds. Finished files are included; incomplete uploads are not.

Client plugin changes reload facets in place. A changed base bundle restarts the client. React and terminal scopes release their subscriptions and references when disposed. Page state survives component replacement within one client host; it does not survive that host's destruction.

Connection hooks run on their options object. Reconnect admission reads the current retry callback after each disconnect.

Browser styles are loaded inactive before code reload. Only accepted plugins activate their prepared styles. Old styles remain until the page draws a frame. Failed and timed-out loads report `stylesheet_failed`; cancellation removes prepared styles. A client records the script each plugin actually runs, so reconnect can retry a failed replacement. An object's retained UI can show without its old styling while that object restarts.

The Node terminal launcher retains credentials outside the sandbox. It requires Node 26.5.1 or later and mediates file, browser and clipboard actions through confirmation. It permits drawing escapes and removes terminal configuration escapes from sandbox output. Its bridge bounds frames to 17 MiB and bundle downloads to 8 MiB. Exit restores terminal modes and removes launcher listeners.

## Telemetry

Recorded timing uses milliseconds with microsecond precision. Telemetry queues are bounded. In-flight writes count toward their bounds. A storage failure stops the recorder and rejects subsequent flush or close.

A host records activation, resource, method, routine, job, route, remote-call and HTTP lifetimes. Trace carriers cross supported transports. Cancellation keeps an ok status. Errors use bounded messages. Browser ingestion enforces the browser incarnation prefix and accepts at most 1,200 spans per minute. Browser batches hold at most 100 spans. Worker batches hold at most 1,000 spans and 1,000 metric rows.

Link byte counters use the host's telemetry recorder even when the link starts with a different request context.

Browser ingestion charges and stamps one accepted span at a time. If the principal callback fails, later spans in that batch do not consume its rate limit.

## Limits

Facets and plugins run with host-process authority. Reload does not isolate untrusted code. In-memory documents disappear with the process. Persistence requires an attached Store. Links provide reconnection of references, not replay of arbitrary side effects. Synchronous publication means a slow listener delays other listeners in that batch.
