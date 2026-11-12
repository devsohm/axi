import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@axi/ai";
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@axi/codemode";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { createRegistry, defineTool, Harness } from "../../src/index.ts";
import { createCodemodeExtension } from "../../src/codemode/index.ts";
import { openNodeJsonlStorage } from "../../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";

const [directory, backend, mode, restartLimit] = process.argv.slice(2);
if (!directory) throw new Error("Session directory is required");
const models = createModels(),
	provider = fauxProvider(),
	registry = createRegistry();
const waiting = Promise.withResolvers<void>();
models.setProvider(provider.provider);
if (mode === "codemode")
	registry.install(
		createCodemodeExtension({
			sandbox: new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() }),
			models: false,
		}),
	);
registry.install({
	name: "crash-tools",
	tools: [
		defineTool({
			name: "effect",
			description: "Record a completed effect",
			parameters: Type.Object({}),
			replay: "safe",
			async execute() {
				await appendFile(join(directory, "effects.log"), "effect\n");
				return { output: [{ type: "text", text: "effect committed" }] };
			},
		}),
		defineTool({
			name: "wait",
			description: "Wait for a service",
			replay: "safe",
			parameters: Type.Object({}),
			async execute() {
				await appendFile(join(directory, "attempts.log"), "attempt\n");
				waiting.resolve();
				await new Promise(() => {});
				return { output: [{ type: "text", text: "unreachable before restart" }] };
			},
		}),
	],
});
provider.setResponses(
	mode === "codemode"
		? [
				fauxAssistantMessage(
					[
						fauxToolCall(
							"codemode",
							{
								code: 'const first=await tools.effect({}); const second=await tools.wait({}); store("answer",{first,second}); return second;',
							},
							{ id: "code-call" },
						),
					],
					{ stopReason: "toolUse" },
				),
			]
		: [
				fauxAssistantMessage([fauxToolCall("effect", {}, { id: "effect-call" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("wait", {}, { id: "wait-call" })], { stopReason: "toolUse" }),
			],
);
try {
	const storage =
		backend === "jsonl"
			? await openNodeJsonlStorage(directory, context)
			: await openNodeSqliteStorage(join(directory, "session.sqlite"));
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			settings: {
				compaction: { enabled: false },
				...(restartLimit === undefined ? {} : { restartLimit: Number(restartLimit) }),
			},
		},
		context,
	);
	harness.resume();
	const conversation = await harness.root(context, {
		agent: { model: { provider: provider.provider.id, modelId: provider.getModel().id } },
	});
	const submission = await conversation.submit(
		{ type: "input", content: "Persist and wait", requestId: "crash-once" },
		context,
	);
	await waiting.promise;
	process.send?.({ kind: "ready", conversationId: conversation.id, submissionId: submission.id });
} catch (error) {
	process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exit(1);
}
