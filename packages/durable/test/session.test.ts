import { BACKGROUND_CONTEXT as context, withCancel } from "@axi/chord/context";
import { createModels } from "@axi/ai";
import { describe, expect, it } from "vitest";
import {
	createRegistry,
	createSession,
	defineDoc,
	defineEntry,
	Harness,
	MemoryStorage,
	StorageRequestError,
	type ConversationId,
} from "../src/index.ts";
import { SessionImpl } from "../src/session/session.ts";
const Counter = defineDoc({
	checkpointWhen: () => false,
	kind: "counter",
	version: 1,
	scope: "session",
	initial: () => ({ count: 0 }),
});
const deferred = () => Promise.withResolvers<void>();

describe("Session lifecycle", () => {
	it("captures a typed entry kind before the storage read settles", async () => {
		const session = createSession(new MemoryStorage());
		try {
			const entry = await session.commit(async (tx) => {
				const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
				return tx.appendEntry(conversation.id, { kind: "receipt", data: { accepted: true } });
			}, context);
			let kind = "receipt";
			let reads = 0;
			const token = {
				...defineEntry<{ accepted: boolean }>("receipt"),
				get kind() {
					reads++;
					return kind;
				},
			};
			await session.commit(async (tx) => {
				const pending = tx.entry(token, entry.id);
				expect(reads).toBe(1);
				kind = "different";
				expect(await pending).toEqual(entry);
				expect(reads).toBe(1);
			}, context);
		} finally {
			await session.close(context);
		}
	});
	it("schedules document eviction from the current host setting", async () => {
		let reads = 0;
		const scheduled: { delay: number; background: boolean }[] = [];
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: createModels(),
				registry: createRegistry(),
				now: () => 0,
				settings: () => ({ documentRetentionMs: ++reads * 100 }),
				setTimer: (_callback, delay, options) => {
					scheduled.push({ delay, ...options });
					return () => {};
				},
			},
			context,
		);
		reads = 0;
		scheduled.length = 0;
		try {
			await harness.commit((tx) => tx.doc(Counter), context);
			expect(scheduled).toEqual([{ delay: 400, background: true }]);
			expect(await harness.snapshot(Counter, context)).toEqual({ count: 0 });
		} finally {
			await harness.close(context);
		}
	});
	it.each(["documentState", "watchDoc"] as const)(
		"retains observer registration state when %s cannot register a close listener",
		async (method) => {
			const failure = new Error("Close listener registration failed");
			class Session extends SessionImpl {
				activeObservers = 0;
				override observeCommits(listener: Parameters<SessionImpl["observeCommits"]>[0]): () => void {
					const remove = super.observeCommits(listener);
					this.activeObservers++;
					return () => {
						this.activeObservers--;
						remove();
					};
				}
				override subscribeClose(): never {
					throw failure;
				}
			}
			const session = new Session(new MemoryStorage());
			try {
				await session.commit((tx) => tx.doc(Counter), context);
				await expect(
					method === "documentState" ? session.documentState(Counter, context) : session.watchDoc(Counter, context),
				).rejects.toBe(failure);
				expect(session.documentCacheSizes.attached).toBe(1);
				expect(session.activeObservers).toBe(1);
				expect(await session.snapshot(Counter, context)).toEqual({ count: 0 });
			} finally {
				await session.close(context);
			}
		},
	);
	it("returns whether a listener was removed", async () => {
		const session = new SessionImpl(new MemoryStorage());
		for (const method of ["subscribeCommits", "observeCommits", "subscribeClose"] as const) {
			const remove = session[method](() => {});
			expect(remove()).toBe(true);
			expect(remove()).toBe(false);
		}
		await session.close(context);
		expect(await session.closed).toEqual({ reason: "closed" });
	});
	it.each(["documentState", "watchDoc"] as const)("captures the document definition once for %s", async (method) => {
		const session = createSession(new MemoryStorage());
		const token = defineDoc({
			checkpointWhen: () => false,
			kind: "definition-test",
			version: 1,
			scope: "session",
			initial: () => ({ count: 7 }),
		});
		await session.commit((tx) => tx.doc(token), context);
		const definition = token.definition;
		let reads = 0;
		Object.defineProperty(token, "definition", {
			get() {
				reads++;
				if (reads > 1) throw new Error("Definition was reread");
				return definition;
			},
		});
		try {
			const observer =
				method === "documentState"
					? await session.documentState(token, context)
					: await session.watchDoc(token, context);
			expect(observer?.value).toEqual({ count: 7 });
			expect(reads).toBe(1);
			if (observer && "dispose" in observer) observer.dispose();
			else await observer?.stop();
		} finally {
			await session.close(context);
		}
	});
	it("rejects undefined settlement details without changing a queued submission", async () => {
		const storage = new MemoryStorage();
		const session = createSession(storage);
		try {
			const submission = await session.commit(async (tx) => {
				const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
				return tx.createSubmission({ conversationId: conversation.id, type: "input", status: "queued" });
			}, context);
			await expect(
				session.commit(
					(tx) => tx.settleSubmission(submission.id, { status: "unanswered", reason: "cancelled", detail: undefined }),
					context,
				),
			).rejects.toThrow(TypeError);
			expect((await storage.submission(submission.id, context))?.status).toBe("queued");
		} finally {
			await session.close(context);
		}
	});
	it("retains committed values through eviction and clears its cache on close", async () => {
		let clock = 100;
		const session = new SessionImpl(
			new MemoryStorage(),
			() => clock,
			() => 10,
		);
		await session.commit(async (tx) => {
			(await tx.doc(Counter)).count = 7;
		}, context);
		const state = (await session.documentState(Counter, context))!;
		clock = 1000;
		await session.commit(() => {}, context);
		expect(session.documentCacheSizes).toMatchObject({ cached: 1, attached: 1 });
		state.dispose();
		clock += 100;
		await session.commit(() => {}, context);
		expect(session.documentCacheSizes.cached).toBe(0);
		expect(await session.snapshot(Counter, context)).toEqual({ count: 7 });
		await session.close(context);
		expect(await session.closed).toEqual({ reason: "closed" });
		expect(session.documentCacheSizes).toMatchObject({ cached: 0, idle: 0, attached: 0 });
	});
	it("releases a pin when close overtakes a cold observer acquisition", async () => {
		const arrived = deferred();
		const released = deferred();
		class Storage extends MemoryStorage {
			hold = false;
			override async findDocument(...args: Parameters<MemoryStorage["findDocument"]>) {
				if (this.hold) {
					arrived.resolve();
					await released.promise;
				}
				return super.findDocument(...args);
			}
		}
		const storage = new Storage();
		const session = new SessionImpl(storage);
		await session.commit((tx) => tx.doc(Counter), context);
		await session.unloadDocuments();
		storage.hold = true;
		const state = session.documentState(Counter, context);
		await arrived.promise;
		const closed = session.close(context);
		released.resolve();
		await expect(state).rejects.toThrow("closed");
		await closed;
		expect(session.documentCacheSizes).toMatchObject({ cached: 0, idle: 0, attached: 0 });
	});
	it("rejects an invalid table read without failing the Session", async () => {
		class Storage extends MemoryStorage {
			override async conversation(_id: ConversationId): Promise<never> {
				throw new StorageRequestError("invalid request");
			}
		}
		const session = createSession(new Storage());
		await expect(session.commit((tx) => tx.conversation(8 as ConversationId), context)).rejects.toThrow(
			"invalid request",
		);
		await session.commit(async (tx) => {
			(await tx.doc(Counter)).count = 3;
		}, context);
		expect(await session.snapshot(Counter, context)).toEqual({ count: 3 });
		await session.close(context);
	});
	it("fails on a storage read even if the callback catches its error", async () => {
		const failure = new Error("backend unavailable");
		class Storage extends MemoryStorage {
			override async conversation(_id: ConversationId): Promise<never> {
				throw failure;
			}
		}
		const session = createSession(new Storage());
		await expect(
			session.commit(async (tx) => {
				await tx.conversation(8 as ConversationId).catch(() => {});
			}, context),
		).rejects.toMatchObject({ name: "SessionFailed", cause: failure });
		expect(await session.closed).toEqual({ reason: "failed", error: failure });
		await expect(session.snapshot(Counter, context)).rejects.toMatchObject({ name: "SessionFailed" });
	});
	it("does not pass cancellation to an admitted storage commit", async () => {
		const arrived = deferred();
		const release = deferred();
		let signal: AbortSignal | undefined;
		class Storage extends MemoryStorage {
			override async commit(...args: Parameters<MemoryStorage["commit"]>) {
				signal = args[1].abortSignal;
				arrived.resolve();
				await release.promise;
				return super.commit(...args);
			}
		}
		const session = createSession(new Storage());
		const child = withCancel(context);
		const commit = session.commit(async (tx) => {
			(await tx.doc(Counter)).count = 9;
		}, child.context);
		await arrived.promise;
		child.cancel(new Error("caller left"));
		release.resolve();
		await commit;
		expect(signal).toBeUndefined();
		expect(await session.snapshot(Counter, context)).toEqual({ count: 9 });
		await session.close(context);
	});
});
