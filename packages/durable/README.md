# @axi/durable

Durable conversations, tasks, storage and execution environments for agent applications.

The [tutorial](docs/tutorial.md) runs a document transaction, a conversation with a tool, and a task with a checkpoint.

The [contracts](docs/spec.md) describe record ownership, document lifetimes, scheduling, extensions, settings, and storage recovery.

Create a conversation without a model or network connection:

```ts
import { BACKGROUND_CONTEXT } from "@axi/objects/context";
import { createSession, MemoryStorage } from "@axi/durable";

const session = createSession(new MemoryStorage());
try {
	const conversation = await session.commit(
		tx => tx.createConversation({ ownership: { kind: "ownerless" } }),
		BACKGROUND_CONTEXT,
	);
	console.log(conversation.id);
} finally {
	await session.close(BACKGROUND_CONTEXT);
}
```

```text
2
```

The package root exports `createSession`, `defineDoc`, `defineDocFamily`, `defineEntry`, `defineTask`, `MemoryStorage`, and their types. Memory storage commits mixed record batches atomically. It supports indexed scans, fork-aware conversation history, document revisions, retirement, and detached reads.

A Session prepares transactions in order. Immediate commits publish after storage succeeds. Deferred document commits publish in memory and are stored before a dependent commit, at their deadline, or during close. Document drafts support structural updates, checkpoints, version conversion, retirement, and replacement. Snapshots expose published values. Document watches and observers follow the same address through retirement and recreation. Closing a Session stops observation and waits for admitted work before closing storage. A storage failure closes the Session.

`@axi/durable/env` exports portable filesystem and shell contracts, result helpers, UTF-8 decoding and line scanning. Line scans report raw byte offsets and decoded sizes without retaining the file.

`@axi/durable/env/node` exports `NodeExecutionEnv`. It provides file operations, streaming readers, paged directory readers, file watches, shell commands and direct process execution. Commands support cancellation, timeouts, output callbacks and raw output spills.

`@axi/durable/storage/sqlite` exports `SqliteStorage` and the SQLite schema initializer. It accepts the asynchronous SQLite database contract from `@axi/objects`. Indexed record queries, document history, and sequence allocation use atomic transactions. Schema prefixes isolate applications in one database.

`@axi/durable/storage/sqlite/node` opens file-backed or in-memory storage with Node SQLite. `@axi/durable/storage/sqlite/cloudflare` opens storage on a SQLite-backed Durable Object.

`@axi/durable/storage/store` exports `StoreStorage`. It keeps Durable records and document history in the shared Store from `@axi/objects`. Open the Store, then call `StoreStorage.open(store, owner, context)`. Each owner has separate tables and document claims. Closing storage releases its claims and leaves the Store open for the application to close. Store exports, imports, and outbox replay include this data.

`@axi/durable/storage/jsonl` opens portable file-backed storage. It writes document and live-task sidecars before publishing each commit in `main.jsonl`. Reopening discards torn final lines and unconfirmed tails, replays confirmed commits, and rejects corruption. Current-only document history and terminal-task sidecars are reclaimed after publication. `fsync: true` flushes sidecars before the main marker; it does not guarantee every acknowledged tail commit survives host failure.

`@axi/durable/storage/jsonl/node` supplies the local Node filesystem. A directory belongs to one writer.

Tasks are created inside Session transactions with explicit ownership. Creating a task and its documents is atomic. An owner that is cancelled or finishing cannot create new owned work. Terminal settlement retires the task's documents.

`AgentDoc` stores conversation choices. `configure` updates those choices by name. `ProviderDoc` stores a stable provider session ID and gives each fork a fresh ID. `UsageDoc`, `InboxDoc`, and `LiveDoc` store accounting, queued submissions, and running progress.

Compaction settings can apply to one conversation. For example, `await conversation.configure({ compaction: { enabled: false } }, context)` disables its automatic compaction. Set `compaction: null` to use the harness settings again. Settings persist and are inherited by child conversations and forks. See the [compaction rules](docs/spec.md#conversation-compaction-settings) for model overrides and validation.

`ToolTask` executes model and nested tool calls. It records arguments and replay policy before execution, streams bounded progress, validates structured results, and stores nested results in task-scoped documents. Interrupted calls run again only when both the recorded and current policies allow safe replay.

`Harness.open(storage, options, context)` connects models, an extension registry, settings and execution environments. Conversations accept input, continue interrupted runs, queue follow-ups, fork history, compact context and expose committed views through observers and watches. The scheduler executes phases, joins owned work, handles cancellation and sleep, and restores checkpoints after reopening. Generation, tool execution and compaction use that same scheduler.

Invocation contexts carry cancellation and explicit telemetry spans. `HarnessOptions.telemetry` accepts a host-owned root adapter. Public submissions and task phases emit spans; committed entries, settlements, checkpoints, replays and reports emit metadata events. Task and submission records persist adapter-owned trace carriers. Metrics track phase durations, live tasks and report categories. No exporter is installed automatically.

`@axi/durable/tools` provides optional `read`, `write`, `edit` and `bash` factories. The read tool returns file text or an image block as structured output, so other tools and Code Mode can use its result directly. Reads bound their memory use and report continuation separately from file content. Edits and writes serialize mutations of the same canonical file. Shell output streams with bounded retention and a file containing complete output when it exceeds the limits.

`@axi/durable/images` prepares images with Photon. The Node adapter uses an idle worker thread by default. Pass ordinary `Uint8Array` bytes to the worker. Convert a Node Buffer with `Uint8Array.from(buffer)` first because pooled Buffers can fail transfer. The Cloudflare adapter accepts its compiled WebAssembly module.

`@axi/durable/codemode` provides a script tool and its prompt section. Scripts call nested tools through recorded task keys. A delivery journal restores result order after restart and rejects changed execution paths. Successful scripts commit their conversation store with their result. Model catalog, classifier and image calls are optional. Code Mode does not install MCP.

An extension groups its tools with `namespace: { name, description, instructions? }`.
The prompt lists selected namespaces even before their tools arrive. Scripts read
the longer instructions with `describeNamespace()` and find deferred tools with
`searchTools()`. `namespacesOf(extensions)` maps tool names to their first owning
extension's namespace. Prefix-based namespace options are no longer supported.

`@axi/durable/testing` provides runner-independent storage and environment checks, a Vitest/Jest assertion adapter, registration helpers and deterministic storage benchmark datasets. Custom storage and environment implementations can run the same checks through their public interfaces.

## Browser storage

`@axi/durable/storage/indexeddb` exports `IndexedDbStorage`. Call `IndexedDbStorage.open(name)` in a browser, then pass the result to `createSession` or `Harness.open`. Each commit uses one IndexedDB transaction for records, document revisions and allocation counters. Close storage before deleting its database with `IndexedDbStorage.delete(name)`. Use one application owner per database.

Harness requests use Axi attribution by default. `Harness.open` accepts an `identity` option; request-level identity fields take precedence. The model collection can be supplied directly or through a factory.

[API reference](docs/api.md)
