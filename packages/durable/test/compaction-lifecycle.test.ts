import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { expect, test } from "vitest";
import {
	CompactionEntry,
	CompactionTask,
	createRegistry,
	defineExtension,
	Harness,
	hook,
	MemoryStorage,
} from "../src/index.ts";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";

function setup() {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	const options = {
		models,
		registry,
		settings: { compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 350, backgroundTokens: 0 } },
	};
	return { models, provider, registry, options };
}
const messageText = (value: { content: unknown }) =>
	typeof value.content === "string" ? value.content : JSON.stringify(value.content);

for (const backend of ["memory", "jsonl", "sqlite"] as const) {
	test(`${backend} compaction keeps raw entries and installs a shortened context`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-compact-")),
			memory = new MemoryStorage();
		const storage = () =>
			backend === "memory"
				? Promise.resolve(memory)
				: backend === "jsonl"
					? openNodeJsonlStorage(directory, context)
					: openNodeSqliteStorage(join(directory, "session.sqlite"));
		const f = setup();
		const harness = await Harness.open(await storage(), f.options, context);
		try {
			const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			for (let turn = 1; turn <= 3; turn++) {
				f.provider.setResponses([fauxAssistantMessage(`answer ${turn}: ` + "saved ".repeat(200))]);
				expect(
					(
						await (
							await conversation.submit(
								{ type: "input", content: `question ${turn}: ` + "details ".repeat(200) },
								context,
							)
						).wait(context)
					).status,
				).toBe("done");
			}
			const before = (await conversation.entries({}, 100, undefined, context)).items.toReversed();
			f.provider.setResponses([fauxAssistantMessage("Saved decisions and completed work.")]);
			const task = await harness.waitForTask(await conversation.compact("Preserve decisions", context), context);
			expect(task.state.outcome.status).toBe("completed");
			if (task.state.outcome.status !== "completed") throw new Error("Compaction failed");
			const submissionId = task.state.outcome.result.submissionId;
			if (submissionId === undefined) throw new Error("Compaction did not create a placement submission");
			expect((await (await harness.submission(submissionId, context))?.wait(context))?.status).toBe("done");
			const after = (await conversation.entries({}, 100, undefined, context)).items.toReversed();
			expect(after.slice(0, before.length)).toEqual(before);
			expect(after.filter(CompactionEntry.is).map((entry) => entry.data.reason)).toEqual(["manual"]);
			const view = await conversation.context(context);
			expect(messageText(view.messages[0]!)).toContain("Saved decisions and completed work.");
			expect(view.messages.slice(1).map((message) => message.role)).toEqual(["user", "assistant"]);
			expect(messageText(view.messages[1]!)).toContain("question 3:");
			await harness.close(context);
			if (backend === "memory") return;
			const reopened = await Harness.open(await storage(), f.options, context);
			try {
				const restored = await reopened.root(context);
				expect((await restored.context(context)).messages).toEqual(view.messages);
				expect((await restored.entries({}, 100, undefined, context)).items.toReversed()).toEqual(after);
			} finally {
				await reopened.close(context);
			}
		} finally {
			await harness.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("a compaction hook can decline without consuming a model response or cutting history", async () => {
	const f = setup();
	const decisions: string[] = [];
	f.registry.install(
		defineExtension({
			name: "retain-history",
			hooks: [
				hook(CompactionTask, {
					beforeCompact(input) {
						decisions.push(`${input.reason}:${input.instructions}`);
						return { decline: true };
					},
				}),
			],
		}),
	);
	const harness = await Harness.open(new MemoryStorage(), f.options, context);
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		f.provider.setResponses([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("second answer"),
			fauxAssistantMessage("next answer"),
		]);
		expect(
			(
				await (
					await conversation.submit({ type: "input", content: "long history ".repeat(300) }, context)
				).wait(context)
			).status,
		).toBe("done");
		expect(
			(
				await (
					await conversation.submit({ type: "input", content: "later context ".repeat(300) }, context)
				).wait(context)
			).status,
		).toBe("done");
		const before = (await conversation.entries({}, 100, undefined, context)).items.toReversed();
		expect(
			(await harness.waitForTask(await conversation.compact("retain", context), context)).state.outcome,
		).toMatchObject({ status: "completed" });
		expect(decisions).toEqual(["manual:retain"]);
		expect((await conversation.entries({}, 100, undefined, context)).items.toReversed()).toEqual(before);
		expect(
			(await (await conversation.submit({ type: "input", content: "continue" }, context)).wait(context)).status,
		).toBe("done");
		expect(JSON.stringify((await conversation.context(context)).messages.at(-1)?.content)).toContain("next answer");
	} finally {
		await harness.close(context);
	}
});
