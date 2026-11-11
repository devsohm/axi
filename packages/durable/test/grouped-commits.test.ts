import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { describe, expect, it } from "vitest";
import { MemoryStorage, SessionFailed } from "../src/index.ts";
import type { Context } from "@axi/objects/context";
import { SessionImpl } from "../src/session/session.ts";
import type { Storage } from "../src/types.ts";

class PausedStorage extends MemoryStorage {
	readonly sizes: number[] = [];
	readonly entriesAtClose = new Map<number, readonly string[]>();
	readonly entered = Promise.withResolvers<void>();
	readonly released = Promise.withResolvers<void>();
	pause = false;
	refuseGroup: Error | undefined;
	override async commit(
		batches: Parameters<Storage["commit"]>[0],
		receive: Parameters<Storage["commit"]>[1],
		ctx: Context,
	) {
		this.sizes.push(batches.length);
		const pause = this.pause;
		this.pause = false;
		if (this.refuseGroup !== undefined && batches.length > 1) {
			await super.commit(batches.slice(0, 1), receive, ctx);
			return { stored: 1, refused: this.refuseGroup };
		}
		const result = await super.commit(batches, receive, ctx);
		if (pause) {
			this.entered.resolve();
			await this.released.promise;
		}
		return result;
	}
	override async close(ctx: Context) {
		for (const { id } of (await this.scanConversations({}, 10, undefined, ctx)).items)
			this.entriesAtClose.set(
				id,
				(await this.scanEntries({ conversationId: id }, 10, undefined, ctx)).items.map((entry) => entry.kind),
			);
		await super.close(ctx);
	}
}

describe("concurrent session commits", () => {
	it("keeps receipts private until storage settles and batches independent callbacks without repeating them", async () => {
		const storage = new PausedStorage(),
			session = new SessionImpl(storage);
		const conversations = await session.commit(async (tx) => {
			const ids = [];
			for (let i = 0; i < 3; i++) ids.push((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
			return ids;
		}, context);
		const changes: unknown[] = [];
		const observation = session.observeCommits({ advance: (change) => changes.push(change), end: () => {} });
		storage.sizes.length = 0;
		storage.pause = true;
		const called = [0, 0, 0],
			admitted = Promise.withResolvers<void>();
		const commits = conversations.map((id, index) =>
			session.commit((tx) => {
				called[index]!++;
				return tx.appendEntry(id, { kind: `message.${index}` });
			}, context),
		);
		void session.readOnLine(async () => admitted.resolve()).catch(() => {});
		try {
			await storage.entered.promise;
			await admitted.promise;
			expect(changes).toHaveLength(0);
			storage.released.resolve();
			const entries = await Promise.all(commits);
			expect(called).toEqual([1, 1, 1]);
			expect(storage.sizes).toEqual([1, 2]);
			expect(changes).toHaveLength(3);
			for (const entry of entries) expect((await storage.entry(entry.id, context))?.entry).toEqual(entry);
		} finally {
			storage.released.resolve();
			await Promise.allSettled(commits);
			observation.detach();
			await session.close(context);
		}
	});

	it("publishes the durable prefix of a refused group and rejects the unwritten part", async () => {
		const storage = new PausedStorage(),
			session = new SessionImpl(storage);
		const ids = await session.commit(async (tx) => {
			const ids = [];
			for (let i = 0; i < 3; i++) ids.push((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
			return ids;
		}, context);
		storage.pause = true;
		const failure = new Error("write refused"),
			admitted = Promise.withResolvers<void>();
		const first = session.commit((tx) => tx.appendEntry(ids[0]!, { kind: "first" }), context);
		await storage.entered.promise;
		storage.refuseGroup = failure;
		const second = session.commit((tx) => tx.appendEntry(ids[1]!, { kind: "stored" }), context);
		const third = session.commit((tx) => {
			return tx.appendEntry(ids[2]!, { kind: "refused" });
		}, context);
		const settled = Promise.allSettled([first, second, third]);
		void session.readOnLine(async () => admitted.resolve()).catch(() => {});
		await admitted.promise;
		storage.released.resolve();
		const results = await settled;
		expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
		expect(results[2]).toEqual({ status: "rejected", reason: failure });
		await session.close(context);
		expect(storage.entriesAtClose.get(ids[1]!)).toEqual(["stored"]);
		expect(storage.entriesAtClose.get(ids[2]!)).toEqual([]);
	});

	it.each(["stored-then-rejected", "missing-receipt"] as const)(
		"preserves stored data and seals later work after a %s group",
		async (mode) => {
			const failure = new Error("Group connection lost");
			class Storage extends PausedStorage {
				override async commit(...args: Parameters<PausedStorage["commit"]>) {
					const [batches, receive, ctx] = args;
					if (batches.length === 1) return super.commit(...args);
					await super.commit(batches.slice(0, 1), mode === "missing-receipt" ? () => {} : receive, ctx);
					if (mode === "stored-then-rejected") throw failure;
					return { stored: 1, refused: failure };
				}
			}
			const storage = new Storage(), session = new SessionImpl(storage);
			const ids = await session.commit(async (tx) => {
				const ids = [];
				for (let index = 0; index < 3; index++)
					ids.push((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
				return ids;
			}, context);
			const published: string[] = [];
			session.observeCommits({
				advance: ({ changes }) => {
					for (const change of changes) if (change.type === "entry") published.push(change.value.kind);
				},
				end() {},
			});
			storage.pause = true;
			const first = session.commit((tx) => tx.appendEntry(ids[0]!, { kind: "first" }), context);
			await storage.entered.promise;
			const second = session.commit((tx) => tx.appendEntry(ids[1]!, { kind: "durable" }), context);
			const third = session.commit((tx) => tx.appendEntry(ids[2]!, { kind: "unwritten" }), context);
			const results = Promise.allSettled([first, second, third]);
			const admitted = Promise.withResolvers<void>();
			void session.readOnLine(async () => admitted.resolve()).catch(() => {});
			await admitted.promise;
			storage.released.resolve();
			try {
				const [one, two, three] = await results;
				expect(one.status).toBe("fulfilled");
				if (two.status !== "rejected" || three.status !== "rejected") throw new Error("The failed group resolved");
				if (mode === "stored-then-rejected") {
					expect(two.reason).toBe(failure);
					expect(three.reason).toBe(failure);
				} else {
					expect(two.reason).toBeInstanceOf(Error);
					expect(two.reason).not.toBe(failure);
					expect(three.reason).toBeInstanceOf(SessionFailed);
					expect(three.reason.cause).toBe(two.reason);
				}
				await expect(session.commit(() => {}, context)).rejects.toMatchObject({ name: "SessionFailed", cause: two.reason });
				expect(published).toEqual(mode === "stored-then-rejected" ? ["first", "durable"] : ["first"]);
				await session.close(context);
				expect(await session.closed).toEqual({ kind: "failed", error: two.reason });
				expect([...storage.entriesAtClose.values()]).toEqual([["first"], ["durable"], []]);
			} finally {
				storage.released.resolve();
				await results;
				await session.close(context);
			}
		},
	);
});
