# Durable contracts

This reference describes persistent records, transactions, scheduling, extension APIs, and storage. The [tutorial](tutorial.md) contains executable examples.

## Shared Store backend

`StoreStorage.open(store, owner, context)` implements `Storage` over the shared Store. Its six declared tables hold record IDs, conversations, entries, head markers, tasks, and submissions. Structured document state uses the Store's document engine. Owner names separate each adapter's data and claims.

Each logical Durable commit stages one composite Store write. The adapter submits independent logical commits through the Store's commit series. Each receives its own sequence and keeps its atomic changes and outcome. IDs come from the Store's allocator.

Record lookups and fork-aware scans use the declared indexes. Document reads combine the record and its history in one read transaction. Request errors are reported after that transaction returns and do not stop the Store. Closing the adapter waits for admitted commits and mints, releases its claims, and keeps the application-owned Store open.

## Session ownership

A Session owns conversations, immutable entries, tasks, submissions, and JSON documents. It executes mutation callbacks in order through `commit(change, context)`. Independent prepared commits can share a storage call while earlier I/O is pending. Each remains atomic and publishes in callback order.

A commit proceeds through callback execution, preparation, storage settlement, adoption, and publication. Documents and records become observable together after storage succeeds. A thrown callback or preparation failure discards its changes. Drafts expire when the callback settles.

External effects run outside the mutation transaction. A database commit cannot atomically include a remote request, process execution, or human interaction.

Table reads must precede the first table write in a transaction. A later table read throws `ReadAfterWrite`. Document access remains available after table writes. Creation methods return the new ID or record.

`observeCommits()` registers an observer for complete stored publications. Internal close listeners run when admission closes. Publication callbacks must not block or wait for another Session operation. Document listeners run outside the mutation callback.

Closing seals admission and lets admitted work settle before storage closes. Cancellation of a waiting caller does not undo an admitted storage operation. A storage failure makes the open Session unusable. `closed` reports either `closed` or `failed`.

## Record identity

Conversation, entry, task, submission, and document IDs are branded numbers. The root conversation ID is `1`. Committed record IDs are not reused. Commit sequences increase, but need not be consecutive.

SQLite keeps new ID allocations in memory until a commit records its allocation boundary. Unused IDs allocated while its final writes are in progress can be reused after reopening; IDs in committed records remain reserved.

| Record | Persistent content |
|---|---|
| Conversation | Identity, optional fork point, and optional owning task |
| Entry | Conversation, kind, model contributions, application data, and optional context edits |
| Task | Input, definition version, owner, lifecycle state, and progress or outcome |
| Submission | Input or write identity, optional request ID, placement, and settlement |
| Document | Address, incarnation, lifetime, version, and bases or deltas |

Entries are immutable. Context edits omit or replace an earlier entry's model contributions without rewriting that entry. A fork retains its parent's history through the selected entry and adds its own entries.

`defineEntry()` supplies typed application data and a kind predicate. Built-in entry tokens describe user input, assistant output, system updates, tool results, resets, and compaction.

## Document definitions

`defineDoc()` describes one document at an address. `defineDocFamily()` adds a string key and a seed for each family member. A definition has a kind, positive integer version, initial value factory, scope, and required `checkpointWhen()` policy.

| Scope | History and fork behavior |
|---|---|
| `session` | One live address across the Session |
| `task` | Owned by one task and retired when that task settles |
| `conversation`, `history: "latest"` | Current value only, with `current` or `initial` fork behavior |
| `conversation`, `history: "rewindable"` | Historical values, with `asOf`, `current`, or `initial` fork behavior |

`asOf` copies the value at the fork entry. `current` copies the current parent value. `initial` uses the definition's initial state when the child first creates the document.

Retiring a document releases the retired incarnation. Watches and synchronous observers remain attached to its address and receive a replacement when a later incarnation appears. Task document observations end when their owner becomes terminal.

`tx.doc()` creates or opens a mutable draft. Document reads within that transaction observe its changes. Assigned containers are copied by value and must contain strict JSON. Held draft handles cannot mutate state after the transaction ends.

`checkpointWhen()` selects complete bases instead of further deltas. Return `false` when no periodic checkpoint is needed. Task-scoped built-in documents use this policy because they retire with their task. The Code Mode store writes a new base when the previous base already has 64 deltas. A version converter reads older content through `migrate(value, fromVersion)`. Reading a newer version through an older definition fails.

`snapshot()` returns the current committed value. `snapshotAsOf()` accepts rewindable conversation documents and a historical entry. Reads do not expose storage-owned mutable objects.

## Observation

`watchDoc()` follows a document address from its current incarnation. It returns an initial value, `start(listener)`, `stop()`, and a `closed` promise. It does not create a missing document. A retirement call retains the last value and sets `retired: true`. A later incarnation arrives as a root replacement. A task document's watch ends after delivering its owner's terminal changes. Closing the session ends watches with `ended`; a failed session ends them with `failed`.

`observeDoc()` attaches a synchronous observer at a document address. Its `value` is the attachment snapshot. Each later call supplies an unfolded change and its commit context. `detach()` is idempotent and prevents further calls, including during the current commit. A throwing observer is reported, detached and ended with `listener_error`. Session close ends synchronous observers with a `failed` result containing `session closed`, so adapters can attach to the next session.

Stored commits update document observers during ordered publication, after the storage call settles. `observeCommits()` dispatches stored publications one microtask later, before the commit settles. Deferred commits can hold changes to existing conversation documents with `latest` history and an `initial` fork policy. Memory observers see each held change once. Stored publications include the folded held changes when a writing commit reads or changes that document, its persistence deadline expires, its tracker reloads or unloads, or the session closes. Failed sessions do not flush held changes. The default persistence window is 1,000 milliseconds; an infinite window waits for another flush trigger.

A watch reports committed values and operations. Retirement is a value call, so the watch can follow a later incarnation. Its terminal reason is `stopped`, `aborted`, `ended`, `listener_error`, or `failed`.

`Conversation.watch()` supplies committed conversation state through asynchronous delivery. Each value call contains the current view, its changes and a retirement flag. Readers render this state directly. Partial output reaches the view through live documents.

`observeConversation()` and `observeTaskGraph()` attach synchronous observers. `ConversationWindow` bounds the transcript in a conversation view. Its first-entry cursor identifies the loaded history boundary. `ConversationTranscript` combines that window with a paged entry loader, fills gaps after reconnecting, and loads earlier entries on request. A caller supplies storage access and renders the resulting transcript.

`watchTaskGraph()` exposes task ownership, waits, running state, and blockers. Inspection describes persisted work without starting its phases.

## Durable tasks

`defineTask()` combines a name, version, initial checkpoint, phase handlers, and an abort handler. The checkpoint's `phase` selects its handler. A handler saves progress through `runtime.commit()`.

| State | Meaning |
|---|---|
| `pending` | Persisted work awaiting admission |
| `running` | A phase can execute |
| `waiting` | Progress depends on named tasks under `failFast`, `allSettled`, or `any` policy |
| `sleeping` | Progress resumes at a persisted deadline or a delivered signal |
| `completing` | An outcome exists while owned work settles |
| `terminal` | The final outcome is committed |

Terminal outcomes are `completed`, `failed`, `aborted`, `orphaned`, or `faulted`. Checkpoints and task memos do not remain on terminal records.

Tasks belong to a conversation or another task. Owned work is joined during settlement. An owner that is cancelling or completing cannot admit new children. Task-scoped documents retire with their task.

`runtime.memo()` retains a named JSON value with the task. `sleepUntil()` persists a wake deadline and checkpoint. Host timers wake execution but are not the persistent source of truth.

`defineSignal({ name, version, schema, migrate? })` declares a typed JSON value. Deliver it with `harness.signal(taskId, token, key, value, context)` or `tx.signal()`. Delivery returns `delivered`, `duplicate`, `invalid`, `closed`, or `not_found`. The key must be non-empty. Values are checked against the schema and copied into the task's persisted memos.

A task can commit `{ status: "sleeping", checkpoint, signals: [token.key(key)], until? }`. It releases its invocation until a value arrives or the deadline passes. A value delivered before the sleep is retained. `runtime.readSignal(token, key, context)` returns the value, an expired marker, or `undefined`; older values require an explicit migration. A key can wake one wait. A later wait cannot reuse a consumed or expired key.

`state.wake` identifies the signal, deadline, expiry, or ended tasks that resumed the task. It survives commits of the same checkpoint and restart recovery, then clears when the checkpoint changes. `any` waits resume after at least one listed task ends; the usual ownership join still applies before the waiting task becomes terminal.

`SubmissionDraft.notify: { taskId, key }` delivers `SubmissionSettled` in the commit that settles the submission. The value is the same settled record returned by `Submission.wait()`. A closed or missing recipient does not prevent settlement.

On reopen, the scheduler reconciles interrupted work with its registered definition. Missing or incompatible definitions remain visible as blockers. A definition can convert older input and checkpoints. `abandonOnRestart` work follows its restart abort path.

Closing a Harness first stops and joins its invocations, then releases provider resources for the session identities it used. An idle Harness does not clear another Harness's provider sessions. Cleanup failures are reported as model-host errors while remaining cleanup handlers still run.

A phase that returns without advancing its persistent state faults. Repeated restarts are bounded by `restartLimit`. Retrying a phase can repeat an external effect that completed before its receipt committed. Stable service request keys and replay policies belong to that effect's implementation.

## Harness and conversations

`Harness.open(storage, options, context)` takes a model collection, registry reader, and optional settings and host adapters. A Harness also implements Session document and transaction operations.

`root()` opens the root conversation. `createConversation()` creates another scope. `conversation(id)` looks up an existing scope. A conversation supports `configure`, `submit`, `reset`, `compact`, `commit`, `context`, `entries`, `fork`, `abort`, and `waitForIdle`.

The Harness provides `resume`, `wake`, `inspect`, task and submission lookup, cancellation, waiting, usage, and task graph operations. Scheduling starts through resume or operations that need progress. Opening and inspecting persisted work alone does not execute phases.

An input submission moves from `queued` to `placed`, then to `done` or `unanswered`. A write submission saves an application entry without requesting a model answer. Request IDs identify duplicate submissions within one conversation.

A `continue` submission resumes from the committed context without adding a user message. It can join queued inputs or a previous failed run. It rejects while the conversation is busy. Set `whenIdle: "reject"` on an input to refuse admission when the conversation is idle. Use `conversation.submit(tx, draft)` inside an existing transaction when admission must commit with other changes.

Busy input policy is `steer`, `followUp`, or `reject`. Queue settings determine whether a boundary consumes one queued item or all eligible items. Submission cancellation reports whether the input was aborted, already placed, or already settled.

`AgentDoc` stores model, thinking level, enabled extensions and tools, instructions, and working directory. Configuration stores names rather than executable extension objects. Model session identity, usage, inbox items, and live progress use separate document definitions.

`maxTurns` bounds tool rounds in one run. It must be a positive safe integer; a configuration update with `null` removes the bound. After the last allowed round runs its tools, an otherwise continuing run ends with `turn_limit`. A final answer or unanimous tool termination completes normally. `LiveDoc` records the turn count and the most recent run failure.

### Conversation compaction settings

`AgentState.compaction` stores a conversation's `CompactionSettings`. The resolved agent exposes these settings. `configure({ compaction })` replaces the whole stored value, `null` clears it, and `undefined` keeps it. Child conversations and forks inherit the settings with the rest of the agent state.

Each policy field uses the first defined value from these layers:

1. The conversation's override for the exact `provider/modelId`.
2. The harness's override for that model.
3. The conversation's general settings.
4. The harness policy, including defaults.

The conversation's general `enabled: false` also overrides the harness's model-specific flag. Its own model-specific flag can enable compaction again. Disabling automatic compaction prevents threshold, background and context-overflow compaction; an explicit `compact()` call remains available.

`reserveTokens`, `keepRecentTokens` and `backgroundTokens` must be safe integers of zero or more, including within model overrides. Invalid configuration throws `RangeError` and commits no changes. Undefined fields are omitted from storage. Threshold checks use the request's agent settings. Overflow handling uses that phase's agent settings, and a compaction task resolves settings when it selects the summary range.

## Extensions and tools

`createRegistry()` holds extensions by name. An extension can register tools, prompt sections, task definitions, task hooks, and wrappers. A snapshot captures registrations for an invocation. The registry loads definitions; an application owns importing modules and supplying them.

`registryReader(value, context)` adapts an observed registry value into the same Harness interface. Its listeners run synchronously for new values; a failed composition retains the last snapshot. The source owns cancellation and observation cleanup. This adapter does not load modules or implement a second extension registry.

`defineExtension()`, `defineTool()`, `section()`, `hook()`, `wrapTool()`, and `wrapSection()` provide typed definitions. Agent configuration chooses active extensions, executable tools, and tools shown to the model separately.

Tool declarations include a name, description, TypeBox argument schema, and asynchronous `execute` function. Optional fields select replay policy, execution mode, argument preparation, structured output validation, allowed callers, deferred discovery, and output limits.

Tools return model-visible output and can also return structured output, details, diagnostics, usage, and control requests. An error result remains a result with `isError`; an exception follows the task's failure path.

The tool API exposes its conversation and task identities, model collection, resolved environment, document reads, transactions, named memos, progress output, child tasks, and nested tool calls. Stable nested-call keys allow recovery to find an already recorded call.

`ToolTask` persists call arguments and the original replay policy before execution. An interrupted invocation repeats only when both recorded and current policies permit replay. Results and bounded progress are saved through the Session.

Generation hooks are `beforeRequest`, `beforeProviderRequest`, `afterResponse`, `onYield`, `afterTools`, and `afterRun`. Tool hooks are `beforeTool` and `afterTool`. Compaction exposes `beforeCompact`. Each hook runs with an invocation context and typed task data. Hook and task APIs read committed entries through `entry()` and `entries()` within their conversation.

`afterRun` receives the completed run's entry bounds and answer. It may return task requests made with `runEndTask()`. Inputs settle before those tasks run, while the conversation remains busy until the tasks finish. Tool hooks also observe rejected and interrupted calls. Replacement results retain the tool's output limits and cannot introduce undeclared structured output.

`beforeProviderRequest` runs after each new provider request body is built. Each hook can replace the body passed to the next hook. A failed hook reports an extension error and leaves the chain running.

Prompt sections have stable keys and render against the resolved agent, environment, committed documents, and sections already shown. System messages carry named section changes and tool additions or removals. Tool declarations and the model's prompt remain consistent at generation boundaries.

`createToolSearchExtension()` exposes deferred tool discovery. Code Mode and MCP remain separately installed features. Installing Code Mode does not connect an MCP server.

Tool discovery searches descriptions and parameter names with BM25. Names and namespace instructions are separate search fields. Exact tool names rank first, followed by the number of matched query terms and relevance. A full local tool name in the query receives an additional relevance weight. Unicode word boundaries and canonical spelling are supported. Code Mode's `searchTools()` uses the same ranking.

Deferred tool discovery follows local schema references when collecting parameter names and descriptions. A referenced definition is read once, so recursive schemas terminate. Unreferenced definitions do not contribute search terms. Malformed references contribute no target terms.

## Built-in execution

`GenerationTask` requests the selected model, commits partial assistant progress, records the final assistant entry, and coordinates tool rounds. `ToolTask` executes the selected tool. `CompactionTask` records a summary and the resulting context boundary.

`UsageDoc` retains usage accounting. `ProviderDoc` retains a stable provider session ID and gives a fork a fresh identity. `LiveDoc` retains active generation, tools, nested calls, and compaction state for observers.

`@axi/durable/tools` exports `read`, `write`, `edit`, and `bash` factories. The host supplies an execution environment. File mutations serialize by canonical file path. Read and shell output limits bound retained content and report truncation. Large shell output can spill to an environment file.

`@axi/durable/env` defines filesystem and shell capabilities. Its Node adapter provides local files, directory pages, watches, and processes. `@axi/env` supplies separate local-daemon and SSH-backed environments through the same execution contract.

`@axi/durable/images` prepares image input. The Node adapter uses a worker thread. The Cloudflare adapter accepts compiled Photon WebAssembly.

## Code Mode

`createCodemodeExtension()` uses a supplied sandbox to execute scripts. Callable tools appear as script functions. Nested effects and global answers have recorded delivery order, so replay can reject a changed execution path.

The run document records the initial script configuration and outcome. A journal records delivered answers. Successful conversation store changes commit with the script result. The sandbox fingerprint identifies the implementation and prelude used for replay.

Tool search and descriptions use the script's captured tool declarations. Optional model operations expose catalogs, classification, and image generation. Paid model operations use internal nested tool tasks with their own usage and cancellation.

## Storage contract

`Storage.commit(batches, receive, context)` accepts an ordered array of logical write batches. Each batch is atomic. Successful batches form a durable prefix. The result gives the number stored and an optional refusal for the next batch. A refusal discards that batch and every later batch in the call. A storage-call rejection can still carry earlier durability receipts. Writes cover conversations, entries, tasks, submissions, document creation, document copy, document change, and document retirement.

Exact lookups are keyed. Ordered scans use an opaque cursor and a requested page limit. Entry scans default to descending ID order. Conversation, task, and submission scans default to ascending order. Returned records and documents are detached from storage-owned mutable values.

Document history stores bases and subsequent Objects deltas. A copy names a source document and point. Backends resolve a historical point without exposing their physical representation to the Harness.

| Backend | Ownership and persistence |
|---|---|
| `MemoryStorage` | Copies retained writes and returned values. State lives in one process. |
| `SqliteStorage` | Checks each logical batch before writing within one SQL transaction; a refused batch keeps the accepted prefix. Record and document queries use indexes. |
| `JsonlStorage` | Uses a portable filesystem, one writer per directory, and confirmed sidecar commits. |
| `IndexedDbStorage` | Uses a browser database with atomic record, document and allocation updates. |
| `StoreStorage` | Uses an application-owned shared Store, with separate tables and document claims for each owner. |

SQLite checks grouped batches with indexed reads, validates them in memory and writes their net changes in multi-row statements. A document copy first flushes earlier accepted writes so its source is visible. Large text rows use bound columns within the 100-parameter limit; other rows use JSON arrays. This reduces statement round trips while preserving each batch's sequence and refusal boundary.

SQLite accepts Objects's asynchronous database contract. `openNodeSqliteStorage()` uses Node SQLite. `openDurableObjectSqliteStorage()` uses a SQLite-backed Durable Object. An optional schema prefix isolates table and index names. Opening applies pending schema versions atomically and refuses an unsupported newer version.

JSONL stores table records and commit markers in `main.jsonl`. Document incarnations use `doc-<id>.jsonl`; live tasks use `task-<id>.jsonl`. A commit appends sidecars first, then its main marker, then publishes in memory.

Reopening discards torn final lines and unconfirmed sidecar tails. Missing required confirmed data is corruption. An uncertain append failure poisons the open backend. Reclamation follows a confirmed replacement base or retirement.

The JSONL `fsync` default is `false`. Enabling it flushes affected sidecars before the marker, but ordinary publication does not flush `main.jsonl`. An acknowledged tail commit can still disappear after host failure. Destructive reclamation first flushes its authorizing main marker.

For a viewer beside a running JSONL writer, pass `{ readOnly: true }` to `JsonlStorage.open()` or `openNodeJsonlStorage()`. This open creates and changes no files. It ignores torn final lines and unconfirmed sidecar tails in memory, performs no reclamation, and retains the committed snapshot it read at open. `commit()` rejects with `JsonlStorageReadOnlyError`. If recovery encounters corruption while the main file grows, it retries up to five times because the writer may have reclaimed an older sidecar meanwhile. Stable corruption still rejects the open.

These backends implement the same record contract. A Harness uses one selected Storage instance. It does not maintain a second authoritative database or automatically mirror SQLite into JSONL.

## Settings and host adapters

| Setting | Default |
|---|---|
| `retry` | Enabled, 3 retries, 2,000 ms base delay, 60,000 ms maximum agent delay |
| `compaction` | Enabled, 16,384 reserve tokens, 20,000 recent tokens, 32,768 background tokens |
| `progress` | 100 ms partial interval, 100 ms output interval, and 1,000 ms persistence window |
| `toolExecution` | `parallel` |
| `steeringMode`, `followUpMode` | `one-at-a-time` |
| `contextRetentionMs`, `documentRetentionMs` | 600,000 ms |
| `afterFailedRun` | `keep` |
| `restartLimit` | `5` |

Host adapters supply settings, models, execution environments, conversation initialization, clock, timers, wake notifications, and error reports. `HarnessOptions.telemetry` accepts an explicit root adapter. `DURABLE_TELEMETRY_SCHEMA` defines submission and phase spans, commit events, and metrics. Input admission starts a root linked to its caller; write admission is a caller child. Phase spans include the decision commit and exclude durable waits and restart delays.

Task creation inherits the caller's injected carrier unless `trace` is supplied. `trace: "root"` stores no carrier. Creation `links` are attached during the first invocation, including its successive phases. After reopening, the first invocation is marked `resumed`. Queued inputs retain their admission traces; combined runs use the first input as parent and link the others. Carriers are stored with records in every backend.

Committed entry and settlement events are emitted after storage succeeds, including when no commit listener exists. Reports record fixed categories without error payloads. Phase faults and AI request errors can include diagnostics limited to 500 characters. Prompts, entry data, tool arguments and tool outputs are not recorded. Hosts own exporters, adapter lifetime and carrier transport limits.

## Integration checks

`@axi/durable/testing` exposes storage and environment conformance cases, assertion adapters, registration helpers, and deterministic benchmark datasets. These functions operate through the same public contracts that an application supplies.

The package does not supply a terminal UI, a command-line product, credential storage policy, or an OS sandbox. Applications compose those capabilities around the Harness.

## IndexedDB

The IndexedDB backend implements the same storage interface as memory, SQLite and JSONL. A transaction publishes its sequence counter and mixed record writes together. An aborted transaction publishes neither. IDs survive reopening. Fork scans respect ancestor cutoffs, and document reads reconstruct a base plus subsequent changes. Closing rejects new operations, waits for admitted operations and closes the database connection. Database deletion requires other connections to be closed.

## Client identity

The harness adds default application attribution to its models. Harness identity overrides those defaults field by field, and request identity overrides the harness identity. This applies to models returned by a factory and to model calls made through tool or task context. A null attribution disables attribution without removing the user agent.

The browser database uses schema version 1. Its stores are `meta`, `record_ids`, `conversations`, `entries`, `tasks`, `submissions`, `documents`, and `document_revisions`. Records carry indexed columns beside their `record` value. Entry rows also carry `commitSeq`. Document revision keys are `[documentId, seq]`. Version-change events do not automatically close the owner's connection; the owner must close it before another connection upgrades or deletes the database.

## Read-only access

Open a Harness with `readOnly: true` to inspect existing records without recovering tasks or scheduling work. Writes reject with `ReadOnlySession`. A transaction that writes nothing still succeeds. `resume()` refuses scheduling and `wake()` returns `{ active: false }`. Storage opening has its own policy: also pass `readOnly: true` to a JSONL backend to prevent recovery writes. The Harness option alone does not make a database driver physically read-only.

Storage calls `receive(index, seq)` exactly once for each durable batch, in input order. A receipt reports durability; it does not publish Session state. After the storage call settles, the Session adopts and publishes received batches in order. It never runs a mutation callback again to retry publication. Reads and scheduler decisions wait for pending writers of the keys they use. Custom storage backends must supply ordered receipts and the matching result; the receipt callback must not throw.

Conversation tails, head markers, task records, and bounded immutable record caches avoid repeated storage reads. Caches update at publication. Context ranges advance from committed entries and fall back to a storage scan when they missed a publication. Closing drains admitted work and deferred document writes before closing storage.
