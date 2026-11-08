# Objects specification

## JSON revisions

The [JSON revision contract](delta.md) defines draft ownership, preparation, replay and streaming. Published revisions and operations are immutable by contract. Object copies preserve plain and null prototypes, own data properties and unchanged nested values.

## Identity and declarations

Object identity consists of contract, canonical parameters and principal. Parameters are required and cannot declare defaults. Contract declarations own immutable schema snapshots and fingerprints. Equal versions require compatible fingerprints. Accepted older versions use explicit adapters. Schema `format` fields describe values without validating their format; constraints such as `pattern` still apply.

`bytes()` returns a plain `{ type: "bytes", minLength?, maxLength? }` marker. Contract validation checks `Uint8Array` values and their byte lengths without adding executable properties to that marker. Invalid arguments report their JSON Pointer path, the expected type and the received type. Missing and unknown fields report their own paths.

A local contract has one member set. A remote contract has named variants and a host-address function. Placement cannot be overridden by a request. Method arguments and results are checked at dispatch, including local calls. Factories declare synchronously and return an implementation rather than a promise.

## Host lifecycle

`load()` runs once. Local acquisition before loading fails with `not_ready`. Loading publishes accepted declarations together and starts empty-parameter local objects. Its report waits for their first outcome. Failed setup excludes that plugin. Invalid plugin names reject before host state changes.

References report `loading`, `live`, `failed` or `ended`. Their released ownership cannot be reused. Object-owned dependencies remain through an attempt. Call-owned references end with their call context. Root contexts use the host principal by default. An explicit undefined principal creates an anonymous scope.

Dependencies can park activation without consuming its readiness deadline. Transient activation failures retry with backoff. Broken failures wait for an explicit retry or replacement. Native resources close in reverse order. A late opener is closed if its attempt already ended.

Host close stops new work, closes links, seals scopes and objects, drains admitted calls and closes resources. Cleanup continues after individual close failures. The application closes the Store separately.

## Publication and storage

Transactions serialize changes to one object's documents. Store commits order writes across owners. A transaction publishes no draft before storage adoption. Document changes, table changes and live-query refreshes publish in one batch. A failed refresh keeps the last live rows and reports its failure once per episode.

Commits queued behind a running Store step share the next database transaction. Each retains its own sequence, outbox record and adoption. Metadata is written once per group. If a member's writes refuse, the group rolls back and runs its admitted members individually. A failed transaction boundary stops the Store instead of retrying an uncertain outcome.

Persisted state declares a schema version and checkpoint policy. A schema change requires a compatible migration. Tables record version history and bounded migrations. Jobs persist unsettled run records separately from their state. Recovery uses committed records, not unfinished in-memory callbacks.

An uncertain database outcome is terminal for the Store. Export holds its queue until the iterator ends or is cancelled. Import validates and applies the complete archive to an empty database. Optional outbox replay accepts consecutive commits and checks row counts.

## Store sync

The experimental sync API uploads committed outbox records in ordered batches. A remote slot records the preceding sequence, final sequence and writer identity. Existing slots are immutable. A retry by the same writer can adopt its previously accepted slot. A slot from another writer reports divergence. Backends that enforce writer epochs can reject stale writers.

Pull saves a target sequence before applying a batch. After interruption, that marker distinguishes the applied prefix from new local work. Pull refuses unsynced local commits. Archives restore only into an empty backend. Snapshot folding preserves slot ownership after removing old batch bodies.

Batch bodies are gzip streams of version 2 JSON lines. Snapshot bodies compress the existing Store archive format. Upload targets 8 MiB batches. Pull applies about 4 MiB per transaction. A single large record can exceed either target. The filesystem remote supports one writer process and does not enforce epochs. See [Store sync](sync.md).

## Reload

Reload applies a complete facet set. Identical facet objects remain installed. Staging runs no native open or job. Failed plugins retain previous code. Dependency checks preserve a changed consumer's prior code when its required provider update failed.

Publication replaces accepted providers and contributions in one batch. Every affected live object restarts while retaining its documents and tables. Removed types leave held references waiting. Reports retain declaration order. Failed, waiting and activating objects retry on the new code.

Reloads serialize. Cancellation before publication leaves the prior set intact. Cancellation after publication does not undo the accepted update. Error details identify committed plugin changes.

An outgoing attempt remains open for calls already running and calls they cause. New calls wait for the successor. Compatible references can read outgoing state until its attempt seals. A restart waits for its recorded dependencies and for outgoing calls to finish. Readiness references do not appear in presence lists and remain held until the successor checks its own dependencies.

`reloadDrainTimeout` bounds this wait. Its default is 5,000 ms, capped by `closeTimeout`. A timed-out call rejects with `released`, and the host reports `drain_timeout`. Native resources close with reason `reload`. In-memory job runs end with an aborted reload outcome; persisted jobs recover according to their definition. An old call waiting through dependencies or openers on its own reload drain fails with `unavailable/reload_cycle`.

Trusted links propagate outgoing-call ancestry through `call.old`. Untrusted links cannot claim it. Readiness waits through remote version skew until the other host updates or the deadline expires. Local dependency failures report `parked` with their cause. The replacement factory runs after the old attempt closes. Non-native contributions remain until the replacement publishes; native contributions leave at the seal.

## Links and authority

Links handshake before queued work. Untrusted envelopes are validated. Malformed messages, duplicate identifiers and control traffic from an unauthorized role close the channel. Asynchronous handling holds later messages until it completes.

Only parent links can stamp principals and incarnations. Routes authorize each hold before resolution. Revocation ends matching external objects, unbound work and downstream links. The host's own principal is exempt.

Each origin has independent call and state windows. Two unacknowledged local state messages fill the state window. Method replies and control messages remain independent. Remote views keep their last snapshot while disconnected. Sent calls fail on loss and are never replayed automatically.

Before a result or error is sent, the answering host sends that origin's pending state, even when the ordinary state window is full. A relay sends its own pending state before forwarding an answer. These extra state messages use the same ordered acknowledgements. The guarantee covers changes committed by those answering hosts before the answer, not effects left running after it.

A loading transition during reload preserves admitted calls. Calls that crossed the transition use the previous method names until the consumer acknowledges the new binding. Failure, removal, cancellation and link loss still end affected calls.

Default heartbeat settings ping after 15 seconds and close after 30 seconds. A delayed local timer does not count a sleeping process as peer silence. Type names and host kinds are bounded to 256 characters on the wire. Trace carriers have at most eight printable entries of bounded length.

## Jobs and routines

A routine serializes its calls and coalesces source changes during a call. It waits on a failed source until values return. Failed routines retry with backoff. Ending the attempt cancels their contexts and joins admitted work.

A job runs outside its finish transaction. Its successful finish commits cleanup and application changes together. Five finish failures block further tries. A reload can retry a blocked finish. Persisted runs recover their saved arguments, progress and supported trace carrier. Deferred state may be lost before its persistence deadline. Applications own external-effect idempotency.

## Node helpers

Plugin roots may be required or optional. Discovery reports collisions and invalid entries. Builds restrict imports to permitted plugin, shared and host-package paths. Plugin scripts execute as trusted code. File watching marks changes without applying them. Rollouts ship built generations through ordered host steps. Workers evaluate prebuilt scripts without rebuilding them.

HTTP routes deny anonymous callers unless explicitly public. Cross-site routes are public and anonymous. Authentication, host, origin, header and response-body checks run at the request boundary. Resource and root scopes last through response completion or cancellation.

Worker starts serialize per address and hold process locks. Stale file locks are cleared only when no process is listening. A missing child PID is never a signal target. A running worker's lost link permits one recovery per minute for its address. Another loss within that window, a crash or a failed start requires retry or rollout.

## App host and clients

The app host opens one server Store and one Store per worker address. Startup holds a data-directory lock. Closing the app releases that lock after its components close. Persistent device and browser sessions store hashes rather than token secrets. Ephemeral sessions and pending sign-in links remain in memory.

The app chooses `principal.owner`, which must be strict JSON and differ from the server principal. Sign-in, pairing and invites use this value. `AppInfo` version 2 exposes it. Owner comparison uses cached canonical principal keys. Changing the owner revokes the token-file session and replaces that file, leaving other sessions unchanged. Worker kinds require a worker-principal function.

Base bundles record input hashes at the read that supplies the compiler. The restart flag compares current contents with every running base record. It clears after a revert. New source files inside configured base directories set the flag. The server records its entry's static graph when possible; unresolved imports are omitted, while other scan errors report `server_scan` without preventing startup. Browser and terminal bundles inherit the server's resolution conditions unless overridden.

Files contract version 2 stores immutable file versions by space and path. Index mutations serialize per Files object and commit version rows, path counters, blob reference counts and summaries together. Deleting data retains path counters. Moves preserve version identities; copies share blobs without carrying delivery keys. Folder views attach without missing intervening changes and refresh once per affected watched folder. File-only copies export the Files owner's tables and documents while retaining referenced blobs. The previous file index has no automatic migration. See [App host](app.md#files-and-archives).

An address export holds its worker's data through the worker or its process lock. Import requires a new destination, validates archive paths and limits, and publishes the staged directory only after Store import succeeds. Finished files are included; incomplete uploads are not.

Client plugin changes reload facets in place. A changed base bundle restarts the client. React and terminal scopes release their subscriptions and references when disposed. Page state survives component replacement within one client host; it does not survive that host's destruction.

Browser styles are loaded inactive before code reload. Only accepted plugins activate their prepared styles. Old styles remain until the page draws a frame. Failed and timed-out loads report `stylesheet_failed`; cancellation removes prepared styles. A client records the script each plugin actually runs, so reconnect can retry a failed replacement. An object's retained UI can show without its old styling while that object restarts.

The Node terminal launcher retains credentials outside the sandbox. It requires Node 26.5.1 or later and mediates file, browser and clipboard actions through confirmation. It permits drawing escapes and removes terminal configuration escapes from sandbox output. Its bridge bounds frames to 17 MiB and bundle downloads to 8 MiB. Exit restores terminal modes and removes launcher listeners.

## Telemetry

Recorded timing uses milliseconds with microsecond precision. Telemetry queues are bounded. In-flight writes count toward their bounds. A storage failure stops the recorder and rejects subsequent flush or close.

A host records activation, resource, method, routine, job, route, remote-call and HTTP lifetimes. Trace carriers cross supported transports. Cancellation keeps an ok status. Errors use bounded messages. Browser ingestion enforces the browser incarnation prefix and accepts at most 1,200 spans per minute. Browser batches hold at most 100 spans. Worker batches hold at most 1,000 spans and 1,000 metric rows.

## Limits

Facets and plugins run with host-process authority. Reload does not isolate untrusted code. In-memory documents disappear with the process. Persistence requires an attached Store. Links provide reconnection of references, not replay of arbitrary side effects. Synchronous publication means a slow listener delays other listeners in that batch.
