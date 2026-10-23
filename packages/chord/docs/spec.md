# Object runtime specification

This specification describes the public contracts of `@axi/chord`. The [guide](guide.md) explains usage and defaults. The [tutorial](tutorial.md) provides runnable examples.

## Identity and contracts

An object is identified by its type name, normalized input and principal key. Normalization applies schema defaults, removes unknown fields and validates input. Canonical identity omits default-valued fields. Changing those identity rules requires a new type name.

Local contracts describe host-only methods, state and opaque native values. Remote contracts describe JSON input, placement and named variants. Remote placement is part of the contract fingerprint. A request cannot override it. A provider or relay rejects input that selects another destination.

At an equal contract version, the provider must cover every member the consumer requests. Member kinds must agree. Method arguments must accept the consumer's values; state and results must fit its expected schemas. Both parties must agree on whether a method takes arguments. A void consumer discards a result. Opaque descriptors must agree.

A breaking change requires a higher contract version. Consumers of an older version need an explicit `accepts` adapter. Adapters cannot change placement. Identical schema shapes do not detect changes of meaning; authors must version those changes themselves.

Remote calls validate arguments and results at dispatch, including calls within one process. Both consumer and provider schemas remove unknown argument fields before validation. Local calls do not perform per-call schema validation. Outgoing state snapshots and resets are validated; ordinary delta writes receive additional schema checks in development mode.

## Declaration and activation

A factory runs synchronously and returns an implementation. Returning a promise is invalid. It may declare:

| Declaration | Surviving identity |
| --- | --- |
| State | Name; its value survives compatible reloads |
| Reference | Object address and consumer contract |
| Resource | Name, version, dependencies and exclusivity |
| Listener | Name, source and selector |
| Task | Position; execution restarts on reload |
| Derivation | Position; computation is replaced on reload |
| Registration | Registry name and entry key |

Names are nonempty and unique within their declaration kind. Factories cannot write cells, read resources or call references. Dependencies must be declared before activation; in-host reference cycles are rejected.

Activation opens resources in dependency order, waits for references and forwarded state, initializes new cells, attaches derived values and starts runtime listeners and tasks. Initializers run in parallel in separate roots. They must not wait for their own object or another unfinished initializer of that object.

Concurrent acquisitions of one address share activation. Failure unwinds the run and rejects its waiting references. A later acquisition can retry. An activation abandoned by every reference cleans up its result, including a resource that finishes opening after cancellation.

`install()` registers one facet synchronously. `load()` resolves and registers its entire batch before awaiting host-object activation. Registration failures can throw synchronously; installation is not a rollback transaction. Close a host when abandoning startup.

`awaitHostObjects: false` starts the same objects without awaiting them. `ready()` waits for the host-object references present at call time. It does not join background tasks or continuously monitor health. Applications coordinate bootstrap readiness and parent admission explicitly.

## Ownership and lifetime

References expose late-bound members, status, readiness, shape and release operations. Their status is `loading`, `live`, `gone` or `released`. `get()` waits for requested state; `hold()` returns immediately. Initial state reads fail with `not_ready`; unavailable variant members fail with `not_in_variant`. Released references reject further calls.

`self.get()` creates an object-owned reference. `ctx.get()` creates a call-owned reference released when its context settles. External references belong to the caller. Releasing one remote view does not end other views sharing its binding.

The default object lifetime is referenced, with an optional linger delay after its final reference leaves. A local type whose input accepts an empty object can instead have host lifetime. It then has one object for the host principal and cannot linger. Only host-lifetime objects can register contributions.

Disposal stops tasks and listeners, joins invocations, closes resources in reverse opening order and releases dependencies. Forced disposal marks references gone and cancels calls first. Bulk disposal visits referrers before their dependencies and closes links last. Cleanup attempts remaining steps even when another step fails.

## Roots and principals

The application supplies the host principal, accepted peer principals and routed host principals. `principalKey` defines identity. A key equal to the host's own key reaches its own objects. Include grant revisions and connection provenance when they affect identity.

A root is a short call tree with one code version and cancellation scope. Calls using its context keep that scope. Calls without a context, and calls made by long-lived task holders, start fresh roots. Contexts expire when their call settles and cannot be used on another host.

Ingress roots act as their supplied principal. Code inside objects acts as the host. The accepting side stamps downstream principals; only a trusted parent may forward one. Variants describe available members and do not replace application authorization. Revocation disposes matching external objects and re-stamps or closes matching links; pattern revocations propagate to children.

Standalone `Context` is a separate invocation API. Its cancellation, typed values and telemetry span are explicit. `withTelemetry()` accepts a callback span; the application retains the root adapter. Every context exposes span recording methods, including through the disabled default. Derived contexts do not mutate parents. `traceIn()` preserves callback results and rejection identity while passing a span-scoped child context. No ambient span or automatic host instrumentation is installed.

## State and revisions

Roots transferred to trackers, cells or standalone state must be alias-free strict JSON. They are trusted and are not defensively traversed or frozen. Published values and operation payloads remain immutable by contract. Consumers must copy before giving data to mutable code.

Draft insertions validate and copy their inputs before changing state. Invalid insertion is atomic. Arrays remain dense; expanding their length inserts nulls. Draft handles follow elements through array reindexing, expire after settlement or competing adoption, and ignore writes to removed elements.

Preparation produces a candidate and its operations without changing authority. Adoption checks its owner and revision, then changes the root. Foreign, cancelled, stale and consumed preparations are refused. Even a no-op adoption advances the tracker revision and invalidates competitors; observable state does not publish a no-op.

Operation batches support root replacement, property sets and deletes, string append and front truncation, array splices and permutations. Batches reproduce the resulting value but are not canonical. Unsafe prototype-related path segments are rejected by replay and decoding; tracker mutations at those keys fold into a safe ancestor replacement.

Immutable replay shares unchanged containers and operation payloads. Mutable replay requires a detached root and separate batches for each replica. Encoders and decoders belong to one ordered stream. Reset their dictionaries after replacement; recover from a fresh replacement after an invalid stream.

Object cell notifications install related values before observers run. Standalone state subscriptions serialize each subscriber's asynchronous callbacks independently. At most 100 deliveries wait per subscriber; overflow retains the newest value and any unstarted initial hydration. Unsubscribe drops waiting callbacks without cancelling the running one. Callback failures are reported and do not stop later deliveries.

## Watch handles

`Watchable<T>` exposes a current value and an asynchronous `watch(context)` acquisition. A watch begins with the value held at acquisition. Its single listener receives later frames in order and never runs inside `start()` or `advance()`. The handle's `value` changes before each callback. Sources must attach the watch and capture its initial value without losing intervening changes.

`Watch<T>` delivers immutable JSON values, delta operations and the commit context. `NativeWatch<T>` delivers in-process values and contexts without delta operations. Both serialize asynchronous callbacks. When 100 frames are waiting, the next frame replaces the backlog. JSON watches deliver a root replacement using the configured replacement callback or the latest value. Native watches retain the latest value.

`observeCancellation()` installs one acquisition signal. Delivered contexts retain their other fields but do not carry that signal. `stop()`, cancellation, source closure and listener failure end the watch once, detach it from its source and discard queued frames. They do not cancel a callback already running. `closed` reports the terminal reason, and the handle retains its last delivered value. Starting twice, starting after termination or installing cancellation twice is an error.

`retire()` is available for JSON watches whose value includes `null`. It queues a final null replacement, rejects later advances and closes with `retired` after that callback completes. An ordinary frame containing null does not retire a watch. A listener failure is reported and ends that watch; unlike standalone state subscriptions, it does not continue with later callbacks.

## Reload

A host serializes reloads and retains at most current and previous code versions. Preparation records new declarations, checks provider and consumer compatibility, opens nonexclusive candidate resources, checks registrations and stages listeners. Candidate tasks do not run before commit. Failed preparation discards candidates and preserves installed code.

Raising a cell version or replacing an exclusive resource gates the affected object. Roots already holding its lease may finish. Other old roots receive retryable `upgrade_conflict`. New objects of changing types are refused after the admission cut. Gates have a deadline; missing it aborts the reload with its blocking roots.

Cell migration works on a private copy and validates the prospective schemas. A changed schema without a version increase, or a lower version, is refused. Exclusive replacement closes the old resource before opening its replacement; rollback attempts to restore it. A failed restoration marks the resource unavailable.

Commit synchronously publishes implementations, state, tables and shapes, then releases observers and starts new work. A kept resource adopts the new declaration's cleanup. The host's own lifecycle reference adopts a changed provider contract without briefly releasing its object. Other consumers keep normal compatibility checks.

An unexpected commit failure makes the host terminally failed. It must stop admitting calls. Compatible old roots otherwise finish on retained old implementations. Retirement releases declarations used only by that version. A missed retirement deadline cancels remaining roots, allows a bounded grace period and retires anyway. Later calls with an unavailable version fail with `superseded`.

Only direct child hosts participate in a cluster reload. The coordinator gathers votes, commits locally and sends decisions before starting new-version work. Joining or reconnecting hosts are fenced and reconciled. Clients do not vote or supply code-version roots.

## Links and flow control

Memory, IPC and structural WebSocket links carry protocol version 4. Received frames are validated. Malformed frames, duplicate IDs and control frames from the wrong side close the link. Version mismatch invokes the configured callback and closes; versions are not negotiated.

A remote hold implies state unless disabled. A shape becomes visible only after all snapshots it lists arrive. Further member updates use deltas, resets or errors. Remote views of the same key share a hold and member streams. After upstream loss they retain last hydrated values while reconnecting; in-flight calls reject and may already have executed remotely.

Routes authorize before and after resolution and recheck revocation across awaits. Knowing a child host does not authorize a relay. WebSocket authentication completes before buffered frames enter a host.

Acknowledged frame sizes regulate state traffic. Defaults are a 256 KiB window, four windows of pending operations, a 15-second ping interval and a 45-second silence timeout. Overflow replaces stalled streams with current-value resets. Initial snapshots for new holds, method results and control frames bypass waiting state. Therefore a result can precede the state change it caused. IPC links report no encoded sizes and are not windowed. `maxCalls` bounds admitted peer calls when configured.

## Helpers and limits

The Node host manager serializes start, stop and replacement, uses kernel-backed process locks and closes child process trees after a grace period. Applications supply restart and liveness policy. Process-group cleanup computes the target from the child PID. A missing PID uses the sentinel `-1`, so that exceptional path attempts a signal to PID 1; applications must not treat it as a safe missing-process guard.

Output helpers bound head or tail windows without splitting UTF-8 characters, track skipped output and sanitize display controls. Progress writes are coalesced with one write in flight, paced by a minimum interval and 100 KiB per second. Stop joins the active write and returns pending waiters for final delivery.

SQLite adapters expose asynchronous operations over an exclusive transaction queue. The temporary transaction executor expires when its callback settles. Operations on the outer database wait behind that callback and must not be awaited from inside it. Callback failure rolls back; rollback failure is reported separately. Migrations require contiguous versions beginning at one and apply atomically. The Node adapter uses synchronous SQLite internally. Durable Object storage remains owned by its host.

Facets execute as trusted code in the host process. Module generations remain cached. The publication queue is synchronous and shared by hosts in a process. Cluster decisions and module lists are not persisted. Links release provider-side holds on disconnect. Cross-host cycles require application discipline. Cleanup that waits on a disconnected dependency needs an application deadline. Object cells and reload coordination do not provide persistence across process restart.
