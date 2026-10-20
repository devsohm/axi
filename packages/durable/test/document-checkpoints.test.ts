import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { expect, test } from "vitest";
import { CodemodeJournalDoc, CodemodeRunDoc, CodemodeStoreDoc } from "../src/codemode/codemode.ts";
import { NestedCallDoc } from "../src/harness/tool.ts";
import { createSession, MemoryStorage } from "../src/index.ts";

test("task documents retain deltas while the persistent store bounds its replay history", async () => {
	const info = { deltasSinceBase: 1000 };
	expect(NestedCallDoc.definition.checkpointWhen({}, [], info)).toBe(false);
	expect(CodemodeRunDoc.definition.checkpointWhen({}, [], info)).toBe(false);
	expect(CodemodeJournalDoc.definition.checkpointWhen({ entries: [] }, [], info)).toBe(false);
	const storage = new MemoryStorage();
	const session = createSession(storage);
	try {
		const conversation = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		await session.commit(async (tx) => {
			(await tx.doc(CodemodeStoreDoc, conversation.id)).values.count = 0;
		}, context);
		const record = await storage.findDocument(
			{
				kind: CodemodeStoreDoc.definition.kind,
				scope: { kind: "conversation", conversationId: conversation.id },
			},
			"current",
			context,
		);
		if (!record) throw new Error("Store document was not created");
		for (let count = 1; count <= 66; count++) {
			await session.commit(async (tx) => {
				(await tx.doc(CodemodeStoreDoc, conversation.id)).values.count = count;
			}, context);
			if (count === 64 || count === 65 || count === 66) {
				expect((await storage.document(record.id, "current", context))?.deltasSinceBase).toBe(
					count === 64 ? 64 : count - 65,
				);
			}
		}
		expect(await session.snapshot(CodemodeStoreDoc, conversation.id, context)).toEqual({ values: { count: 66 } });
	} finally {
		await session.close(context);
	}
});
