# Durable contracts

This reference describes persistent records, transactions, scheduling, extension APIs, and storage. The [tutorial](tutorial.md) contains executable examples.

## Session ownership

A Session owns conversations, immutable entries, tasks, submissions, and JSON documents. It serializes mutations through `commit(change, context)`.

A commit proceeds through callback execution, preparation, storage settlement, adoption, and publication. Documents and records become observable together after storage succeeds. A thrown callback or preparation failure discards its changes. Drafts expire when the callback settles.

External effects run outside the mutation transaction. A database commit cannot atomically include a remote request, process execution, or human interaction.

Table reads must precede the first table write in a transaction. A later table read throws `ReadAfterWrite`. Document access remains available after table writes. Creation methods return the new ID or record.

`subscribeCommits()` receives a complete committed publication synchronously. `subscribeClose()` runs when admission closes. These listeners must not block or reenter Session operations. Document listeners run outside the mutation line.

Closing seals admission and lets admitted work settle before storage closes. Cancellation of a waiting caller does not undo an admitted storage operation. A storage failure makes the open Session unusable. `closed` reports either `closed` or `failed`.

## Record identity

Conversation, entry, task, submission, and document IDs are branded numbers. The root conversation ID is `1`. Committed record IDs are not reused. Commit sequences increase, but need not be consecutive.

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

Retiring an incarnation ends its observations. Recreating the same address creates a new incarnation. An old observer does not silently attach to that replacement.

`tx.doc()` creates or opens a mutable draft. Document reads within that transaction observe its changes. Assigned containers are copied by value and must contain strict JSON. Held draft handles cannot mutate state after the transaction ends.

`checkpointWhen()` selects complete bases instead of further deltas. Return `false` when no periodic checkpoint is needed. Task-scoped built-in documents use this policy because they retire with their task. The Code Mode store writes a new base when the previous base already has 64 deltas. A version converter reads older content through `migrate(value, fromVersion)`. Reading a newer version through an older definition fails.

`snapshot()` returns the current committed value. `snapshotAsOf()` accepts rewindable conversation documents and a historical entry. Reads do not expose storage-owned mutable objects.

## Observation

`watchDoc()` observes one document incarnation. It returns an initial value, `start(listener)`, `stop()`, and a `closed` promise. It does not create a missing document. Retirement delivers a final null value and ends the watch with reason `retired`. Closing the session ends it with `ended`; a failed session ends it with `failed`.

A watch reports committed values and operations. Its terminal reason distinguishes explicit stop, cancellation, Session close, retirement, listener failure, and Session failure.

`Conversation.watch()` supplies committed conversation state through asynchronous delivery. `watchEvents()` converts committed view changes into agent events. Partial output reaches these views through committed live documents.

`watchTaskGraph()` exposes task ownership, waits, running state, and blockers. Inspection describes persisted work without starting its phases.

## Durable tasks

`defineTask()` combines a name, version, initial checkpoint, phase handlers, and an abort handler. The checkpoint's `phase` selects its handler. A handler saves progress through `runtime.commit()`.

| State | Meaning |
|---|---|
| `pending` | Persisted work awaiting admission |
| `running` | A phase can execute |
| `waiting` | Progress depends on named tasks under `failFast` or `allSettled` policy |
| `sleeping` | Progress resumes at a persisted deadline |
| `completing` | An outcome exists while owned work settles |
| `terminal` | The final outcome is committed |

Terminal outcomes are `completed`, `failed`, `aborted`, `orphaned`, or `faulted`. Checkpoints and task memos do not remain on terminal records.

Tasks belong to a conversation or another task. Owned work is joined during settlement. An owner that is cancelling or completing cannot admit new children. Task-scoped documents retire with their task.

`runtime.memo()` retains a named JSON value with the task. `sleepUntil()` persists a wake deadline and checkpoint. Host timers wake execution but are not the persistent source of truth.

On reopen, the scheduler reconciles interrupted work with its registered definition. Missing or incompatible definitions remain visible as blockers. A definition can convert older input and checkpoints. `abandonOnRestart` work follows its restart abort path.

A phase that returns without advancing its persistent state faults. Repeated restarts are bounded by `restartLimit`. Retrying a phase can repeat an external effect that completed before its receipt committed. Stable service request keys and replay policies belong to that effect's implementation.

## Harness and conversations

`Harness.open(storage, options, context)` takes a model collection, registry reader, and optional settings and host adapters. A Harness also implements Session document and transaction operations.

`root()` opens the root conversation. `createConversation()` creates another scope. `conversation(id)` looks up an existing scope. A conversation supports `configure`, `submit`, `reset`, `compact`, `commit`, `context`, `entries`, `fork`, `abort`, and `waitForIdle`.

The Harness provides `resume`, `wake`, `inspect`, task and submission lookup, cancellation, retry, waiting, usage, and task graph operations. Scheduling starts through resume or operations that need progress. Opening and inspecting persisted work alone does not execute phases.

An input submission moves from `queued` to `placed`, then to `done` or `unanswered`. A write submission saves an application entry without requesting a model answer. Request IDs identify duplicate submissions within one conversation.

Busy input policy is `steer`, `followUp`, or `reject`. Queue settings determine whether a boundary consumes one queued item or all eligible items. Submission cancellation reports whether the input was aborted, already placed, or already settled.

`AgentDoc` stores model, thinking level, enabled extensions and tools, instructions, and working directory. Configuration stores names rather than executable extension objects. Model session identity, usage, inbox items, and live progress use separate document definitions.

## Extensions and tools

`createRegistry()` holds extensions by name. An extension can register tools, prompt sections, task definitions, task hooks, and wrappers. A snapshot captures registrations for an invocation. The registry loads definitions; an application owns importing modules and supplying them.

`defineExtension()`, `defineTool()`, `section()`, `hook()`, `wrapTool()`, and `wrapSection()` provide typed definitions. Agent configuration chooses active extensions, executable tools, and tools shown to the model separately.

Tool declarations include a name, description, TypeBox argument schema, and asynchronous `execute` function. Optional fields select replay policy, execution mode, argument preparation, structured output validation, allowed callers, deferred discovery, and output limits.

Tools return model-visible output and can also return structured output, details, diagnostics, usage, and control requests. An error result remains a result with `isError`; an exception follows the task's failure path.

The tool API exposes its conversation and task identities, model collection, resolved environment, document reads, transactions, named memos, progress output, child tasks, and nested tool calls. Stable nested-call keys allow recovery to find an already recorded call.

`ToolTask` persists call arguments and the original replay policy before execution. An interrupted invocation repeats only when both recorded and current policies permit replay. Results and bounded progress are saved through the Session.

Generation hooks are `beforeRequest`, `afterResponse`, `onYield`, and `afterTools`. Tool hooks are `beforeTool` and `afterTool`. Compaction exposes `beforeCompact`. Each hook runs with an invocation context and typed task data.

Prompt sections have stable keys and render against the resolved agent, environment, committed documents, and sections already shown. System messages carry named section changes and tool additions or removals. Tool declarations and the model's prompt remain consistent at generation boundaries.

`createToolSearchExtension()` exposes deferred tool discovery. Code Mode and MCP remain separately installed features. Installing Code Mode does not connect an MCP server.

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

`Storage.commit(writes, adopt, context)` atomically applies one mixed batch and returns its sequence. Writes cover conversations, entries, tasks, submissions, document creation, document copy, document change, and document retirement.

Exact lookups are keyed. Ordered scans use an opaque cursor and a requested page limit. Entry scans default to descending ID order. Conversation, task, and submission scans default to ascending order. Returned records and documents are detached from storage-owned mutable values.

Document history stores bases and subsequent Chord deltas. A copy names a source document and point. Backends resolve a historical point without exposing their physical representation to the Harness.

| Backend | Ownership and persistence |
|---|---|
| `MemoryStorage` | Copies retained writes and returned values. State lives in one process. |
| `SqliteStorage` | Uses one SQL transaction per Session commit and indexed record and document queries. |
| `JsonlStorage` | Uses a portable filesystem, one writer per directory, and confirmed sidecar commits. |

SQLite accepts Chord's asynchronous database contract. `openNodeSqliteStorage()` uses Node SQLite. `openDurableObjectSqliteStorage()` uses a SQLite-backed Durable Object. An optional schema prefix isolates table and index names. Opening applies pending schema versions atomically and refuses an unsupported newer version.

JSONL stores table records and commit markers in `main.jsonl`. Document incarnations use `doc-<id>.jsonl`; live tasks use `task-<id>.jsonl`. A commit appends sidecars first, then its main marker, then publishes in memory.

Reopening discards torn final lines and unconfirmed sidecar tails. Missing required confirmed data is corruption. An uncertain append failure poisons the open backend. Reclamation follows a confirmed replacement base or retirement.

The JSONL `fsync` default is `false`. Enabling it flushes affected sidecars before the marker, but ordinary publication does not flush `main.jsonl`. An acknowledged tail commit can still disappear after host failure. Destructive reclamation first flushes its authorizing main marker.

These backends implement the same record contract. A Harness uses one selected Storage instance. It does not maintain a second authoritative database or automatically mirror SQLite into JSONL.

## Settings and host adapters

| Setting | Default |
|---|---|
| `retry` | Enabled, 3 retries, 2,000 ms base delay, 60,000 ms maximum agent delay |
| `compaction` | Enabled, 16,384 reserve tokens, 20,000 recent tokens, 32,768 background tokens |
| `progress` | 100 ms partial interval and 100 ms output interval |
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

Open a Harness with `readOnly: true` to inspect existing records without recovering tasks or scheduling work. Writes reject with `ReadOnlySession`. A transaction that writes nothing still succeeds. `resume()` refuses scheduling and `wake()` returns `{ active: false }`. The storage backend can still create its schema while opening; this option does not open the database driver in a physical read-only mode.

The storage commit calls `adopt(seq)` synchronously after the batch becomes durable and before resolving. The callback updates the session's in-memory state. A failed write before durability never calls it. Custom storage backends must implement this callback; it must not throw.
