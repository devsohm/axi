# Code Mode specification

## Ownership and entrypoints

Each run owns a fresh QuickJS VM and its linear memory. The host owns tools, deadlines, cancellation, records and persistence. Scripts can reach host capabilities only through registered tools or globals. The package does not provide an operating-system sandbox for host functions.

The root exports the Node sandbox, portable sandboxes, public types, source and declaration helpers, limits, and the WASM loader. `/portable` excludes Node imports. `/source` contains the source parser, error and Lark grammar. `/declarations` contains schema and declaration renderers. `/worker` is the Node worker entry for bundled hosts. `/cloudflare` exports `CodemodeSandboxDurableObject`, `createInlineCodemodeSandbox()` and the compiled module used by Wrangler.

## Registries

Tools have a name, optional description and JSON schemas, and an `execute(args, { signal })` function. `registerTool()` rejects duplicate original names; `unregisterTool()` reports whether it removed a tool. Runs retain the admitted registry even if registration changes later.

Scripts can call a tool by its original name or normalized JavaScript identifier. Each character that is invalid at its position becomes an underscore, including an initial digit. An empty name normalizes to an underscore. The first tool wins when normalized names collide. `ALL_TOOLS` contains frozen name/description entries for the normalized names. Reading a missing member raises a diagnostic with available or similar names; an `in` check remains available.

Globals use the same function shape but do not appear in `result.calls`. `spread: true` passes the full argument array. A single dot groups functions into a frozen namespace. Reserved names, invalid identifiers and namespace conflicts are rejected. `signature` controls declaration output; it does not change execution.

## Script environment

Code is an async function body: top-level `await` and `return` work. Built-ins and their global bindings are frozen before execution. Instances can still override ordinary prototype methods and error fields. `eval` and `Function` create code within the same VM.

Scripts have no filesystem, network, process, imports, timers or WebAssembly access. A promise with no pending host call that could settle it fails immediately. Each run has independent globals.

Arguments and results make a JSON round trip, with `undefined` permitted as the absence of a payload. A throwing host function rejects its script-side promise with an `Error`. The host must validate arguments and authorize operations; JSON schemas only describe them.

`text()` appends primitives as strings and objects as JSON. Console methods append formatted text with `console: true`. `image()` accepts a base64 data URL, an `image_url` object or an image block. It strips base64 whitespace, rejects malformed data and remote URLs, and detects PNG, JPEG, GIF or WebP from its signature. The declared MIME type does not override the detected type.

`exit()` ends successfully with output and store writes collected so far. Later script output cannot replace that outcome. Pending, unawaited host calls are cancelled when the script settles.

## Results and lifetime

Successful results contain `ok`, `value`, ordered `output`, tool `calls`, and `storeWrites`. Failed results contain `ok: false`, `error`, `output` and `calls`, without store writes. Calls report their name, elapsed duration and `ok`, `error` or `cancelled` status.

Error kinds are `script`, `timeout`, `aborted` and `sandbox`. Script errors include their name and stack when available. Script line numbers are preserved; wrapper text shifts the first line's columns. Output produced before a failure remains available.

`execute()` defaults to a 300,000 ms deadline. A per-run deadline overrides the sandbox default; `Infinity` disables it. A signal or `close()` cancels pending calls and requests VM shutdown. Script failures resolve as results; attempting execution after close rejects. Closing is idempotent.

On Node, each run has a worker thread. `acquireWorker()` reserves capacity after WASM loading and before construction. Its returned callback runs once on actual worker exit or constructor failure. `onWorkerStarted(exited)` receives the exit promise. Settled results and `close()` do not wait for worker exit. A throwing lifetime hook requests termination and still releases capacity when the worker exits.

Bundled hosts can supply `workerUrl` and a compiled `wasm` module. `loadQuickJSWasm(path)` caches successful compilation per path and retries failed loads.

## Bounds

| Bound | Value or behavior |
| --- | --- |
| Stored JSON per value | 256 × 1024 characters |
| Total stored keys and JSON | 1024 × 1024 characters |
| Output text and base64 | 16 × 1024 × 1024 characters |
| Output items | 100,000 |
| Inline interrupt budget | 100,000 polls by default |
| Inline stack guard | 256 KiB |
| Cloudflare default memory cap | 32 MiB per VM |

Output beyond either limit fails the run even if the script catches the error. `memoryLimitBytes` caps the VM heap. Exhausting an inline interrupt budget fails as a timeout; it spans the entire run, including computation separated by host calls. Inline execution blocks its caller, so timers cannot interrupt synchronous computation there.

## Store

The caller supplies a snapshot through `store`. Script `load(key)` returns a fresh decoded value. `store(key, value)` records JSON text; `undefined` deletes a key. Keys must be strings. Unserializable values and oversized writes throw inside the script before changing that key.

Only successful results report writes as `{ set, delete }`. No disk storage is performed by this package. Applying writes atomically with application records is the caller's responsibility.

## Deterministic runs

`start()` accepts declared tools/globals, a finite, non-negative `startedAt`, an unsigned 32-bit `seed`, a store snapshot and `onCall`. It has no default deadline. Unlike `execute()`, the caller answers every call through `deliver(seq, now, callId, outcome)`.

Result sequence numbers are unique positive integers starting at 1. Deliveries may arrive out of order; the VM waits for missing earlier results. `now` must be finite and the VM clock never moves backward. An unserializable outcome leaves the call waiting so the caller can answer again. Rejection properties must be a JSON object; the VM does not replace error `name`, `message` or `stack` from those properties.

The VM uses UTC, seeded randomness and virtual time. `performance.now()` counts from the initial time. `WeakRef` and `FinalizationRegistry` are absent. `onStarted` reports engine versions, the actual prelude hash and configured limits before calls. `onIdle(seq, issued)` reports the last processed result and total calls issued. A terminal result can include `during` with those positions. `finished` means the outcome is decided, not that its VM has exited.

Replay requires the same script, declarations, store, initial time, seed, ordered outcomes and fingerprint. A fingerprint identifies this implementation's engine and prelude; callers must not assume recordings from another implementation are compatible.

## Remote execution

`RemoteCodemodeSandbox` keeps host functions in the caller and sends the VM to the endpoint selected once per run. `serveCodemodeRemote()` runs that VM on its thread. Each exchange carries at most one host call. Output is buffered until a call, terminal event, 1,000 items or 1 Mi characters.

The server caps requested memory and interrupt budget. A failed, missing or prematurely returning endpoint produces a sandbox failure. Caller cancellation settles immediately and answers later exchanges with `stop`. A remote VM already computing continues until an exchange or its interrupt limit.

On Cloudflare, deploy the sandbox Durable Object in a separate Worker so computation does not occupy the session Worker's thread. Its default caps are 32 MiB and 100,000 interrupt polls. Subclasses can override them. The sandbox object persists no application state.

## Source and declarations

`parseCodemodeSource()` permits a first-line `// @options:` JSON object. Supported fields are `max_output_tokens`, a non-negative safe integer, and `timeout_ms`, an integer from 1 through 2,147,483,647. The caller applies these options; the sandbox does not. The parser replaces the directive with an empty line, preserving line numbers. Empty source, invalid or unknown options, missing code and misplaced directives raise `CodemodeSourceError`.

`schemaToType()` renders scalar, object, array, tuple, union and intersection types. It expands local JSON pointers up to 32 times; cycles and remote references become `unknown`. Properties are sorted. Descriptions become comments and constraints become tags. Oversized types lose tags first, then become `unknown`. Tool input declarations default to 16,000 characters. `renderToolSignature()`, `renderToolSample()`, `renderToolOutputType()` and `renderDeclarations()` build model-facing descriptions without runtime validation.
