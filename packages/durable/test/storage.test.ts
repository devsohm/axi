import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { expect, it } from "vitest";
import { idFromNumber, seqFromNumber } from "../src/ids.ts";
import { MemoryStorage, ROOT_CONVERSATION_ID, type EntryId, type SubmissionId, type DocumentId } from "../src/index.ts";

it("does not consume an explicit ID or sequence when another write rejects the batch", async () => {
	const storage = new MemoryStorage();
	await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], () => {}, context);
	await expect(
		storage.commit(
			[
				{
					type: "entry",
					value: {
						id: idFromNumber<EntryId>(Number.MAX_SAFE_INTEGER),
						conversationId: ROOT_CONVERSATION_ID,
						kind: "note",
					},
				},
				{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
			],
			() => {},
			context,
		),
	).rejects.toThrow("already belongs");
	expect(await storage.mintId<EntryId>()).toBe(2);
	expect(await storage.commit([], () => {}, context)).toBe(seqFromNumber(2));
});

it("preserves null-prototype data while detaching nested values", async () => {
	const storage = new MemoryStorage();
	const data = { constructor: { count: 7 } };
	Object.setPrototypeOf(data, null);
	const id = idFromNumber<EntryId>(2);
	await storage.commit(
		[{ type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "note", data } }],
		() => {},
		context,
	);
	data.constructor.count = 99;
	const value = (await storage.entry(id, context))?.entry.data;
	expect(Object.getPrototypeOf(value)).toBe(null);
	expect(value).toEqual({ constructor: { count: 7 } });
});

it("normalizes other prototypes and copies a property's children before reading the next property", async () => {
	const storage = new MemoryStorage();
	const reads: string[] = [];
	const data = {
		get first() {
			reads.push("first");
			return {
				get value() {
					reads.push("nested");
					return 1;
				},
			};
		},
		get second() {
			reads.push("second");
			return 2;
		},
	};
	Object.setPrototypeOf(data, { inherited: "unexpected" });
	const id = idFromNumber<EntryId>(2);
	await storage.commit(
		[{ type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "note", data } }],
		() => {},
		context,
	);
	expect(reads).toEqual(["first", "nested", "second"]);
	const retained = (await storage.entry(id, context))?.entry.data;
	expect(Object.getPrototypeOf(retained)).toBe(Object.prototype);
	expect(retained).toEqual({ first: { value: 1 }, second: 2 });
	await storage.close(context);
});

it("removes an old request index when the same record moves to another conversation", async () => {
	const storage = new MemoryStorage();
	const id = idFromNumber<SubmissionId>(2);
	await storage.commit(
		[
			{
				type: "submission",
				value: { id, conversationId: ROOT_CONVERSATION_ID, requestId: "old", type: "input", status: "queued" },
			},
		],
		() => {},
		context,
	);
	const other = await storage.mintId<import("../src/types.ts").ConversationId>();
	await storage.commit(
		[{ type: "submission", value: { id, conversationId: other, requestId: "new", type: "input", status: "queued" } }],
		() => {},
		context,
	);
	expect(await storage.submissionByRequest(ROOT_CONVERSATION_ID, "old", context)).toBeUndefined();
	expect(await storage.submissionByRequest(other, "new", context)).toEqual({
		id,
		conversationId: other,
		requestId: "new",
		type: "input",
		status: "queued",
	});
});

it("reports a repeated immutable record ID before classifying its earlier record type", async () => {
	const storage = new MemoryStorage();
	await expect(
		storage.commit(
			[
				{
					type: "submission",
					value: {
						id: idFromNumber<SubmissionId>(2),
						conversationId: ROOT_CONVERSATION_ID,
						type: "input",
						status: "queued",
					},
				},
				{ type: "entry", value: { id: idFromNumber<EntryId>(2), conversationId: ROOT_CONVERSATION_ID, kind: "note" } },
			],
			() => {},
			context,
		),
	).rejects.toThrow("ID 2 is written more than once");
	expect(await storage.mintId<EntryId>()).toBe(2);
	await storage.close(context);
});

it("preserves the missing fork-source diagnostic and leaves the rejected ID available", async () => {
	const storage = new MemoryStorage();
	await expect(
		storage.commit(
			[
				{
					type: "document.copy",
					record: {
						id: idFromNumber<DocumentId>(2),
						kind: "state",
						scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
						history: "rewindable",
						fork: "asOf",
					},
					source: { id: idFromNumber<DocumentId>(99), at: seqFromNumber(1) },
				},
			],
			() => {},
			context,
		),
	).rejects.toMatchObject({
		message: "Document copy 2 was rejected",
		cause: { message: "Fork source document 99 cannot be read" },
	});
	expect(await storage.mintId<DocumentId>()).toBe(2);
	await storage.close(context);
});

it("never returns more records than a fractional maximum page size", async () => {
	const storage = new MemoryStorage();
	const ids = [2, 3, 4].map((id) => idFromNumber<import("../src/types.ts").ConversationId>(id));
	await storage.commit(
		ids.map((id) => ({ type: "conversation", value: { id } })),
		() => {},
		context,
	);
	expect(await storage.scanConversations({}, 1.5, undefined, context)).toEqual({
		items: [{ id: 2 }],
		next: { after: 2, order: "ascending" },
	});
	await storage.close(context);
});

it("reads each cursor field once before continuing an indexed scan", async () => {
	const storage = new MemoryStorage();
	const reads: string[] = [];
	const cursor = {
		get after() {
			reads.push("after");
			return 1;
		},
		get order(): "ascending" {
			reads.push("order");
			return "ascending";
		},
	};
	const ids = [2, 3, 4].map((id) => idFromNumber<import("../src/types.ts").ConversationId>(id));
	await storage.commit(
		ids.map((id) => ({ type: "conversation", value: { id } })),
		() => {},
		context,
	);
	expect(await storage.scanConversations({}, 2, cursor, context)).toEqual({
		items: [{ id: 2 }, { id: 3 }],
		next: { after: 3, order: "ascending" },
	});
	expect(reads).toEqual(["after", "order"]);
	await storage.close(context);
});
