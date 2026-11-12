import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@axi/ai";
import { BACKGROUND_CONTEXT as context, awaitWithContext } from "@axi/objects/context";
import { expect, test } from "vitest";
import { createRegistry, defineTool, Harness, hook, ToolTask, type TaskId } from "../src/index.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { commitWrites } from "../src/testing/commit-writes.ts";

test.each([1, 3])("recovery upgrades a version %s tool call before executing its saved arguments", async (version) => {
	const directory = await mkdtemp(join(tmpdir(), "axi-tool-version-"));
	const open = () => openNodeSqliteStorage(join(directory, "session.sqlite"));
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let hold = true;
	const executed: unknown[] = [];
	registry.install({
		name: "upgrade-tools",
		tools: [
			defineTool({
				name: "saved-call",
				description: "Use the saved arguments",
				parameters: Type.Object({ value: Type.Integer() }),
				async execute(args) {
					executed.push(args);
					return { output: [{ type: "text", text: String(args.value) }] };
				},
			}),
		],
		hooks: [
			hook(ToolTask, {
				async beforeTool(_call, _api, ctx) {
					if (hold) {
						entered.resolve();
						await awaitWithContext(release.promise, ctx);
					}
				},
			}),
		],
	});
	provider.setResponses([
		fauxAssistantMessage([fauxToolCall("saved-call", { value: 17 }, { id: "saved-id" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Upgraded and completed"),
	]);
	let harness = await Harness.open(
		await open(),
		{ models, registry, settings: { compaction: { enabled: false } } },
		context,
	);
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const admitted = await conversation.submit({ type: "input", content: "Use the saved call" }, context);
		await entered.promise;
		expect(executed).toEqual([]);
		await harness.close(context);
		const storage = await open();
		let taskId: TaskId;
		try {
			const [saved] = (await storage.scanTasks({ kind: ToolTask.definition.name }, 10, undefined, context)).items;
			if (
				!saved ||
				saved.input === null ||
				typeof saved.input !== "object" ||
				Array.isArray(saved.input) ||
				typeof saved.input.assistant !== "number" ||
				typeof saved.input.callId !== "string"
			)
				throw new Error("No saved model tool call");
			taskId = saved.id;
			const input = version === 1 ? { assistant: saved.input.assistant, callId: saved.input.callId } : saved.input;
			await commitWrites(storage, [{ type: "task", value: { ...saved, version, input } }], context);
		} finally {
			await storage.close(context);
		}
		hold = false;
		harness = await Harness.open(
			await open(),
			{ models, registry, settings: { compaction: { enabled: false } } },
			context,
		);
		harness.resume();
		const receipt = await harness.submission(admitted.id, context);
		if (!receipt) throw new Error("The saved submission was lost");
		expect(await receipt.wait(context)).toMatchObject({ status: "done" });
		expect(executed).toEqual([{ value: 17 }]);
		expect(await harness.getTask(taskId, context)).toMatchObject({
			version: ToolTask.definition.version,
			input: { kind: "model", callId: "saved-id" },
			state: { status: "terminal", outcome: { status: "completed" } },
		});
		expect(provider.state.callCount).toBe(2);
	} finally {
		release.resolve();
		await harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});
