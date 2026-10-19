# @axi/durable

Durable conversations, tasks, storage and execution environments for agent applications.

The [tutorial](docs/tutorial.md) runs a document transaction, a conversation with a tool, and a task with a checkpoint.

The [contracts](docs/spec.md) describe record ownership, document lifetimes, scheduling, extensions, settings, and storage recovery.

Create a conversation without a model or network connection:

```ts
import { BACKGROUND_CONTEXT } from "@axi/chord/context";
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

A Session serializes transactions and publishes changes after storage succeeds. Document drafts support structural updates, checkpoints, version conversion, retirement, and replacement. Snapshots expose committed values. Document states and watches observe one incarnation. Closing a Session stops observation and waits for admitted work before closing storage. A storage failure closes the Session.

`@axi/durable/env` exports portable filesystem and shell contracts, result helpers, UTF-8 decoding and line scanning. Line scans report raw byte offsets and decoded sizes without retaining the file.

`@axi/durable/env/node` exports `NodeExecutionEnv`. It provides file operations, streaming readers, paged directory readers, file watches, shell commands and direct process execution. Commands support cancellation, timeouts, output callbacks and raw output spills.

`@axi/durable/storage/sqlite` exports `SqliteStorage` and the SQLite schema initializer. It accepts the asynchronous SQLite database contract from `@axi/chord`. Indexed record queries, document history, and sequence allocation use atomic transactions. Schema prefixes isolate applications in one database.

`@axi/durable/storage/sqlite/node` opens file-backed or in-memory storage with Node SQLite. `@axi/durable/storage/sqlite/cloudflare` opens storage on a SQLite-backed Durable Object.

`@axi/durable/storage/jsonl` opens portable file-backed storage. It writes document and live-task sidecars before publishing each commit in `main.jsonl`. Reopening discards torn final lines and unconfirmed tails, replays confirmed commits, and rejects corruption. Current-only document history and terminal-task sidecars are reclaimed after publication. `fsync: true` flushes sidecars before the main marker; it does not guarantee every acknowledged tail commit survives host failure.

`@axi/durable/storage/jsonl/node` supplies the local Node filesystem. A directory belongs to one writer.

Tasks are created inside Session transactions with explicit ownership. Creating a task and its documents is atomic. An owner that is cancelled or finishing cannot create new owned work. Terminal settlement retires the task's documents.

`AgentDoc` stores conversation choices. `configure` updates those choices by name. `ProviderDoc` stores a stable provider session ID and gives each fork a fresh ID. `UsageDoc`, `InboxDoc`, and `LiveDoc` store accounting, queued submissions, and running progress.

`ToolTask` executes model and nested tool calls. It records arguments and replay policy before execution, streams bounded progress, validates structured results, and stores nested results in task-scoped documents. Interrupted calls run again only when both the recorded and current policies allow safe replay.

`Harness.open(storage, options, context)` connects models, an extension registry, settings and execution environments. Conversations accept input, queue follow-ups, fork history, compact context and expose committed views and events. The scheduler executes phases, joins owned work, handles cancellation and sleep, and restores checkpoints after reopening. Generation, tool execution and compaction use that same scheduler.

Invocation contexts carry cancellation and explicit telemetry spans. `HarnessOptions.telemetry` accepts a host-owned root adapter. Public submissions and task phases emit spans; committed entries, settlements, checkpoints, replays and reports emit metadata events. Task and submission records persist adapter-owned trace carriers. Metrics track phase durations, live tasks and report categories. No exporter is installed automatically.

`@axi/durable/tools` provides optional `read`, `write`, `edit` and `bash` factories. Reads bound their memory use and report continuation separately from file content. Edits and writes serialize mutations of the same canonical file. Shell output streams with bounded retention and a file containing complete output when it exceeds the limits.

`@axi/durable/images` prepares images with Photon. The Node adapter uses an idle worker thread by default. The Cloudflare adapter accepts its compiled WebAssembly module.

`@axi/durable/codemode` provides a script tool and its prompt section. Scripts call nested tools through recorded task keys. A delivery journal restores result order after restart and rejects changed execution paths. Successful scripts commit their conversation store with their result. Model catalog, classifier and image calls are optional. Code Mode does not install MCP.

`@axi/durable/testing` provides runner-independent storage and environment checks, a Vitest/Jest assertion adapter, registration helpers and deterministic storage benchmark datasets. Custom storage and environment implementations can run the same checks through their public interfaces.
