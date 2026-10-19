# Run conversations and durable tasks

These examples run as separate ES modules. They use in-memory storage and a scripted model, so they need no credentials.

## Commit a document

Create a Session, write a conversation document, and read its committed value.

```ts
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@axi/chord/context";
import { createSession, defineDoc, MemoryStorage } from "@axi/durable";

const context = BACKGROUND_CONTEXT;
const Notes = defineDoc<{ lines: string[] }>({
	kind: "notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ lines: [] }),
});
const session = createSession(new MemoryStorage());
try {
	const conversation = await session.commit(async (tx) => {
		const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
		(await tx.doc(Notes, created.id)).lines.push("first entry");
		await tx.appendEntry(created.id, { kind: "note" });
		return created;
	}, context);
	assert.deepEqual(await session.snapshot(Notes, conversation.id, context), { lines: ["first entry"] });
	console.log("Document committed.");
} finally {
	await session.close(context);
}
```

The output is `Document committed.`. The transaction saves the conversation, document, and entry together. A thrown callback discards its writes.

## Run a conversation with a tool

Install an extension, open a Harness, and submit an input. The scripted model requests the extension's tool before answering.

```ts
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@axi/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@axi/ai";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@axi/durable";

const context = BACKGROUND_CONTEXT;
const multiply = defineTool({
	name: "multiply",
	description: "Multiply two numbers",
	parameters: Type.Object({ left: Type.Number(), right: Type.Number() }),
	execute: async ({ left, right }) => ({ output: [{ type: "text", text: String(left * right) }] }),
});
const registry = createRegistry();
registry.install(defineExtension({ name: "arithmetic", tools: [multiply] }));
const scripted = fauxProvider();
scripted.setResponses([
	fauxAssistantMessage([fauxToolCall("multiply", { left: 6, right: 7 }, { id: "product" })], {
		stopReason: "toolUse",
	}),
	fauxAssistantMessage("The result is 42."),
]);
const models = createModels();
models.setProvider(scripted.provider);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
try {
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	const submission = await root.submit({ type: "input", content: "Multiply 6 by 7." }, context);
	assert.equal((await submission.wait(context)).status, "done");
	const view = await root.context(context);
	const result = view.messages.find(message => message.role === "toolResult");
	assert.deepEqual(result?.content, [{ type: "text", text: "42" }]);
	console.log("Tool result: 42");
} finally {
	await harness.close(context);
}
```

The output is `Tool result: 42`. The Harness saves the model call and tool result. The application supplies credentials and display code when it replaces the scripted provider with a remote provider.

## Run a task with a checkpoint

Define a task with two phases. The first saves a checkpoint. The second saves a terminal receipt.

```ts
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@axi/chord/context";
import { createModels } from "@axi/ai";
import { createRegistry, defineExtension, defineTask, Harness, MemoryStorage } from "@axi/durable";

const context = BACKGROUND_CONTEXT;
type Checkpoint = { phase: "prepare" } | { phase: "finish"; value: number };
const Double = defineTask<{ value: number }, Checkpoint, number>({
	name: "double",
	version: 1,
	initial: () => ({ phase: "prepare" }),
	phases: {
		prepare: async (task, runtime, callContext) => {
			await runtime.commit(() => ({
				status: "running",
				checkpoint: { phase: "finish", value: task.input.value * 2 },
			}), callContext);
		},
		finish: async (task, runtime, callContext) => {
			await runtime.commit(() => ({
				status: "terminal",
				outcome: { status: "completed", result: task.state.checkpoint.value },
			}), callContext);
		},
	},
	abort: async (_task, runtime, callContext) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), callContext);
	},
});
const registry = createRegistry();
registry.install(defineExtension({ name: "calculations", tasks: [Double] }));
const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
try {
	const root = await harness.root(context);
	const id = await root.commit(tx => tx.createTask(Double, { value: 9 }, {
		ownership: { kind: "conversation" },
	}), context);
	const receipt = await harness.waitForTask(id, context);
	assert.deepEqual(receipt.state.outcome, { status: "completed", result: 18 });
	console.log("Task result: 18");
} finally {
	await harness.close(context);
}
```

The output is `Task result: 18`. A phase must save progress or a terminal outcome. Returning without progress faults the task.

## Resume from persistent storage

Replace `new MemoryStorage()` with `await openNodeSqliteStorage(path)` from `@axi/durable/storage/sqlite/node`. Reopen the same database and reinstall the extension definitions before waiting for pending tasks.

Opening a Harness reconciles persisted task records. `resume()`, submission, and operations that wait for task progress start scheduling. Inspection alone does not run phases.

Each external effect needs its own retry policy. A crash after an external effect but before its result commits can repeat that phase. Save a stable request key before the effect, then use that key with an idempotent service.

For JSONL storage, use `JsonlStorage` from `@axi/durable/storage/jsonl` with a filesystem implementation. One writer owns each session directory. The [storage reference](../README.md) describes sidecars and recovery limits.
