import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test, vi } from "vitest";
import { createSession, defineDoc, MemoryStorage, type ConversationId, type Session } from "../src/index.ts";
import { SessionImpl } from "../src/session/session.ts";

const Counter = defineDoc({
	kind: "deferred-counter",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ count: 0 }),
	checkpointWhen: () => false,
});

async function createCounter(session: Session) {
	return session.commit(async (tx) => {
		const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
		await tx.doc(Counter, conversation.id);
		return conversation.id;
	}, context);
}

async function storedCounter(storage: MemoryStorage, conversationId: ConversationId) {
	const record = await storage.findDocument(
		{ kind: Counter.definition.kind, scope: { kind: "conversation", conversationId } },
		"current",
		context,
	);
	if (!record) throw new Error("Counter document was not persisted");
	return record.id;
}

test("an earlier deferred deadline flushes the complete value while observers see each admitted update", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1000);
	const storage = new MemoryStorage(),
		session = createSession(storage);
	const seen: number[] = [];
	try {
		const conversationId = await createCounter(session);
		const id = await storedCounter(storage, conversationId);
		await session.observeDoc(
			Counter,
			conversationId,
			{
				advance: (frame) => {
					if (frame.kind === "value") seen.push(frame.value.count);
				},
				end() {},
			},
			context,
		);
		await session.commit(
			async (tx) => {
				(await tx.doc(Counter, conversationId)).count = 1;
			},
			context,
			{ persistence: { kind: "deferred", withinMs: 100 } },
		);
		await vi.advanceTimersByTimeAsync(10);
		await session.commit(
			async (tx) => {
				(await tx.doc(Counter, conversationId)).count = 2;
			},
			context,
			{ persistence: { kind: "deferred", withinMs: 20 } },
		);
		expect((await storage.document(id, "current", context))?.value).toEqual({ count: 0 });
		expect(await session.snapshot(Counter, conversationId, context)).toEqual({ count: 2 });
		expect(seen).toEqual([1, 2]);
		await vi.advanceTimersByTimeAsync(19);
		expect((await storage.document(id, "current", context))?.value).toEqual({ count: 0 });
		await vi.advanceTimersByTimeAsync(1);
		await session.commit(() => {}, context);
		expect((await storage.document(id, "current", context))?.value).toEqual({ count: 2 });
		expect(seen).toEqual([1, 2]);
	} finally {
		await session.close(context);
		vi.useRealTimers();
	}
});

test("an immediate document update absorbs pending deferred changes without losing increments", async () => {
	const storage = new MemoryStorage(),
		session = createSession(storage);
	try {
		const conversationId = await createCounter(session);
		const id = await storedCounter(storage, conversationId);
		for (let index = 0; index < 3; index++)
			await session.commit(
				async (tx) => {
					(await tx.doc(Counter, conversationId)).count++;
				},
				context,
				{ persistence: { kind: "deferred", withinMs: Infinity } },
			);
		expect((await storage.document(id, "current", context))?.value).toEqual({ count: 0 });
		await session.commit(async (tx) => {
			(await tx.doc(Counter, conversationId)).count++;
		}, context);
		expect((await storage.document(id, "current", context))?.value).toEqual({ count: 4 });
		expect(await session.snapshot(Counter, conversationId, context)).toEqual({ count: 4 });
	} finally {
		await session.close(context);
	}
});

test("loading a newer definition flushes its older deferred value before applying the read migration", async () => {
	const storage = new MemoryStorage(),
		session = createSession(storage);
	const NewCounter = defineDoc({
		...Counter.definition,
		scope: "conversation",
		history: "latest",
		fork: "initial",
		version: 2,
		migrate(value) {
			if (typeof value.count !== "number") throw new Error("Missing counter value");
			return { count: value.count * 10 };
		},
	});
	try {
		const conversationId = await createCounter(session);
		const id = await storedCounter(storage, conversationId);
		await session.commit(
			async (tx) => {
				(await tx.doc(Counter, conversationId)).count = 3;
			},
			context,
			{ persistence: { kind: "deferred", withinMs: Infinity } },
		);
		expect(await session.snapshot(NewCounter, conversationId, context)).toEqual({ count: 30 });
		expect(await storage.document(id, "current", context)).toMatchObject({ version: 1, value: { count: 3 } });
		await session.commit(async (tx) => {
			(await tx.doc(NewCounter, conversationId)).count++;
		}, context);
		expect(await storage.document(id, "current", context)).toMatchObject({ version: 2, value: { count: 31 } });
	} finally {
		await session.close(context);
	}
});

test("unloading documents flushes deferred state and a later snapshot reconstructs it from storage", async () => {
	const storage = new MemoryStorage(),
		session = new SessionImpl(storage);
	try {
		const conversationId = await createCounter(session);
		const id = await storedCounter(storage, conversationId);
		await session.commit(
			async (tx) => {
				(await tx.doc(Counter, conversationId)).count = 9;
			},
			context,
			{ persistence: { kind: "deferred", withinMs: Infinity } },
		);
		await session.unloadDocuments();
		expect((await storage.document(id, "current", context))?.value).toEqual({ count: 9 });
		expect(await session.snapshot(Counter, conversationId, context)).toEqual({ count: 9 });
	} finally {
		await session.close(context);
	}
});

test("a failed deferred flush still closes storage and publishes the original failure", async () => {
	const failure = new Error("Deferred storage write failed");
	class Storage extends MemoryStorage {
		refuse = false;
		override async commit(...args: Parameters<MemoryStorage["commit"]>) {
			if (this.refuse) throw failure;
			return super.commit(...args);
		}
	}
	const storage = new Storage(),
		session = createSession(storage);
	const closed = vi.spyOn(storage, "close");
	const conversationId = await createCounter(session);
	await session.commit(
		async (tx) => {
			(await tx.doc(Counter, conversationId)).count = 1;
		},
		context,
		{ persistence: { kind: "deferred", withinMs: Infinity } },
	);
	storage.refuse = true;
	await expect(session.close(context)).rejects.toThrow();
	expect(await session.closed).toEqual({ kind: "failed", error: failure });
	expect(closed).toHaveBeenCalledOnce();
});

test("a vanished stored document fails a reload instead of manufacturing an initial value", async () => {
	class Storage extends MemoryStorage {
		missing = false;
		override async document(...args: Parameters<MemoryStorage["document"]>) {
			return this.missing ? undefined : super.document(...args);
		}
	}
	const storage = new Storage(),
		session = new SessionImpl(storage);
	try {
		const conversationId = await createCounter(session);
		await session.unloadDocuments();
		storage.missing = true;
		await expect(session.snapshot(Counter, conversationId, context)).rejects.toThrow(/cannot be read/);
	} finally {
		await session.close(context);
	}
});
