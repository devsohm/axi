import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import {
	AgentDoc,
	AssistantEntry,
	createRegistry,
	createSession,
	GenerationTask,
	Harness,
	UserEntry,
} from "../src/index.ts";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { commitWrites } from "../src/testing/commit-writes.ts";

for (const backend of ["sqlite", "jsonl"] as const) {
	test.each([1, 2])(`${backend} resumes generation version %i using its saved input`, async (version) => {
		const directory = await mkdtemp(join(tmpdir(), "axi-generation-migration-"));
		const openStorage = () =>
			backend === "sqlite"
				? openNodeSqliteStorage(join(directory, "session.sqlite"))
				: openNodeJsonlStorage(directory, context);
		const models = createModels(),
			provider = fauxProvider();
		models.setProvider(provider.provider);
		provider.setResponses([
			(request) => {
				expect(request.messages.at(-1)).toMatchObject({ role: "user", content: "Recover this saved input" });
				return fauxAssistantMessage("Recovered migrated generation");
			},
		]);
		let harness: Harness | undefined;
		try {
			const session = createSession(await openStorage());
			let saved;
			try {
				saved = await session.commit(async (tx) => {
					const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
					(await tx.doc(AgentDoc, conversation.id)).model = { provider: "faux", modelId: "faux-1" };
					const entry = await tx.appendEntry(UserEntry, conversation.id, {
						model: [{ role: "user", content: "Recover this saved input", timestamp: 0 }],
					});
					const task = await tx.createTask(
						GenerationTask,
						{},
						{ conversationId: conversation.id, ownership: { kind: "conversation" } },
					);
					return { conversation: conversation.id, entry: entry.id, task };
				}, context);
			} finally {
				await session.close(context);
			}
			const storage = await openStorage();
			const record = await storage.task(saved.task, context);
			if (!record) throw new Error("The saved task was lost");
			await commitWrites(storage, [{ type: "task", value: { ...record, version } }], context);
			harness = await Harness.open(
				storage,
				{ models, registry: createRegistry(), settings: { compaction: { enabled: false } } },
				context,
			);
			expect((await harness.inspect(context)).tasks.find((item) => item.record.id === saved.task)).toMatchObject({
				record: { version },
				state: { kind: "pending", migrates: true },
			});
			harness.resume();
			expect((await harness.waitForTask(saved.task, context)).state.outcome).toMatchObject({ status: "completed" });
			expect((await harness.getTask(saved.task, context))?.version).toBe(GenerationTask.definition.version);
			const conversation = await harness.conversation(saved.conversation, context);
			if (!conversation) throw new Error("The saved conversation was lost");
			const entries = (await conversation.entries({ order: "ascending" }, 20, undefined, context)).items;
			expect(entries.filter(UserEntry.is).map((entry) => entry.id)).toEqual([saved.entry]);
			expect(entries.filter(AssistantEntry.is).map((entry) => entry.model?.[0]?.content)).toEqual([
				[{ type: "text", text: "Recovered migrated generation" }],
			]);
			expect(provider.state.callCount).toBe(1);
		} finally {
			await harness?.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});
}
