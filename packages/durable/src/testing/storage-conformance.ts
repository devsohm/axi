import type { JsonValue } from "@axi/chord";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { idFromNumber } from "../ids.ts";
import {
	type ConversationId,
	type Cursor,
	type DocumentCreate,
	type DocumentId,
	type EntryId,
	type EntryRecord,
	type JsonObject,
	type Page,
	type ScanOrder,
	type Storage,
	type StorageWrite,
	type SubmissionId,
	type SubmissionRecord,
	type TaskId,
	type TaskRecord,
	ROOT_CONVERSATION_ID as ROOT,
} from "../types.ts";
import type { StorageConformanceCase, StorageConformanceOptions } from "./types.ts";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
const entry = (id: EntryId, conversationId = ROOT, extra: Partial<EntryRecord> = {}): EntryRecord => ({
	id,
	conversationId,
	kind: "note",
	...extra,
});
function pending(
	id: TaskId<JsonValue>,
	extra: {
		kind?: string;
		owner?: TaskId;
		background?: boolean;
		abortRequested?: boolean;
		state?: StoredTask["state"];
		memos?: Readonly<Record<string, JsonValue>>;
	} = {},
): StoredTask {
	const { state = { status: "pending", checkpoint: { phase: "ready" } }, memos, ...fields } = extra;
	const base = {
		id,
		conversationId: ROOT,
		kind: "check.task",
		version: 1,
		input: { value: id },
		background: false,
		abortRequested: false,
		...fields,
	};
	return state.status === "terminal" || state.status === "completing"
		? { ...base, state }
		: { ...base, state, ...(memos === undefined ? {} : { memos }) };
}
async function root(storage: Storage): Promise<void> {
	await storage.commit([{ type: "conversation", value: { id: ROOT } }], context);
}
async function all<T>(scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> {
	const values: T[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await scan(cursor);
		values.push(...page.items);
		cursor = page.next === undefined ? undefined : JSON.parse(JSON.stringify(page.next));
	} while (cursor !== undefined);
	return values;
}
function object(value: JsonValue | undefined): JsonObject {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected an object in the stored fixture");
	return value;
}

export function createStorageConformance(options: StorageConformanceOptions): readonly StorageConformanceCase[] {
	const a = options.assertions;
	const cases: StorageConformanceCase[] = [];
	const add = (name: string, run: (storage: Storage) => Promise<void>) => {
		cases.push({ name, run: () => options.withStorage(run) });
	};
	const seeded = (name: string, run: (storage: Storage) => Promise<void>) =>
		add(name, async (storage) => {
			await root(storage);
			await run(storage);
		});
	add("reserves ID 1 for the immutable root conversation", async (storage) => {
		a.strictEqual(await storage.mintId<ConversationId>(), 2);
		await root(storage);
		a.deepEqual(await storage.conversation(ROOT, context), { id: ROOT });
		await a.rejects(
			storage.commit([{ type: "conversation", value: { id: ROOT } }], context),
			`ID ${ROOT} already belongs to conversation`,
		);
	});
	seeded("commits mixed table writes atomically and rolls all of them back on failure", async (storage) => {
		const eid = await storage.mintId<EntryId>(),
			tid = await storage.mintId<TaskId<JsonValue>>(),
			sid = await storage.mintId<SubmissionId>();
		const task = pending(tid);
		const submission: SubmissionRecord = {
			id: sid,
			conversationId: ROOT,
			requestId: "first",
			type: "input",
			status: "placed",
			entry: eid,
		};
		const seq = await storage.commit(
			[
				{ type: "entry", value: entry(eid, ROOT, { data: { text: "start" } }) },
				{ type: "task", value: task },
				{ type: "submission", value: submission },
			],
			context,
		);
		a.deepEqual(await storage.entry(eid, context), {
			entry: entry(eid, ROOT, { data: { text: "start" } }),
			commitSeq: seq,
		});
		a.deepEqual(await storage.task(tid, context), task);
		a.deepEqual(await storage.submission(sid, context), submission);
		const transient = await storage.mintId<EntryId>();
		await a.rejects(
			storage.commit(
				[
					{ type: "entry", value: entry(transient) },
					{ type: "task", value: { ...task, state: { status: "running", checkpoint: { phase: "next" } } } },
					{ type: "submission", value: { ...submission, status: "done", answer: transient } },
					{ type: "conversation", value: { id: ROOT } },
				],
				context,
			),
			"already belongs to conversation",
		);
		a.deepEqual(await storage.task(tid, context), task);
		a.deepEqual(await storage.submission(sid, context), submission);
		a.strictEqual(await storage.entry(transient, context), undefined);
		a.greaterThan(
			await storage.commit([{ type: "entry", value: entry(await storage.mintId<EntryId>()) }], context),
			seq,
		);
	});
	seeded("detaches retained writes and every returned record", async (storage) => {
		const data = { nested: { count: 1 }, items: [1, 2] },
			checkpoint = { phase: "ready", nested: { count: 2 } },
			detail = { nested: { count: 3 }, codes: ["saved"] };
		const eid = await storage.mintId<EntryId>(),
			tid = await storage.mintId<TaskId<JsonValue>>(),
			sid = await storage.mintId<SubmissionId>();
		await storage.commit(
			[
				{ type: "entry", value: entry(eid, ROOT, { data }) },
				{ type: "task", value: pending(tid, { state: { status: "pending", checkpoint } }) },
				{
					type: "submission",
					value: { id: sid, conversationId: ROOT, type: "input", status: "unanswered", reason: "failed", detail },
				},
			],
			context,
		);
		data.nested.count = checkpoint.nested.count = detail.nested.count = 99;
		data.items.push(3);
		detail.codes.push("changed");
		for (let attempt = 0; attempt < 2; attempt++) {
			const e = await storage.entry(eid, context),
				t = await storage.task(tid, context),
				s = await storage.submission(sid, context);
			a.deepEqual(e?.entry.data, { nested: { count: 1 }, items: [1, 2] });
			a.deepEqual(t?.state, { status: "pending", checkpoint: { phase: "ready", nested: { count: 2 } } });
			a.deepEqual(s?.detail, { nested: { count: 3 }, codes: ["saved"] });
			object(object(e?.entry.data).nested).count = 9;
			if (t?.state.status === "pending") object(object(t.state.checkpoint).nested).count = 9;
			object(object(s?.detail).nested).count = 9;
			for (const value of [object(e?.entry.data).items, object(s?.detail).codes]) {
				if (!Array.isArray(value)) throw new Error("Expected a stored array");
				value.push(9);
			}
		}
	});
	seeded("detaches prototype-like JSON keys without changing object prototypes", async (storage) => {
		const id = await storage.mintId<EntryId>();
		const data: JsonObject = JSON.parse(
			'{"__proto__":{"changed":false},"constructor":{"label":"saved"},"toString":"text"}',
		);
		await storage.commit([{ type: "entry", value: entry(id, ROOT, { data }) }], context);
		object(data.__proto__).changed = true;
		object(Reflect.get(data, "constructor")).label = "changed";
		for (let attempt = 0; attempt < 2; attempt++) {
			const value = object((await storage.entry(id, context))?.entry.data);
			a.strictEqual(Object.getPrototypeOf(value), Object.prototype);
			a.strictEqual(Object.hasOwn(value, "__proto__"), true);
			a.deepEqual(value.__proto__, { changed: false });
			a.deepEqual(value.constructor, { label: "saved" });
			a.strictEqual(value.toString, "text");
			a.strictEqual(Object.hasOwn(Object.prototype, "changed"), false);
			object(value.__proto__).changed = true;
		}
	});
	seeded("indexes entries committed out of ID order", async (storage) => {
		const ids = [30, 10, 20].map((value) => idFromNumber<EntryId>(value));
		await storage.commit(
			ids.map((id) => ({ type: "entry", value: entry(id, ROOT, id === ids[2] ? { head: ids[1] } : {}) })),
			context,
		);
		a.deepEqual(
			(await storage.scanEntries({ conversationId: ROOT }, 10, undefined, context)).items.map((item) => item.id),
			[30, 20, 10],
		);
		a.strictEqual((await storage.findLatestHeadMarker(ROOT, undefined, context))?.id, 20);
	});
	seeded("continues an entry cursor below its last item after a newer commit", async (storage) => {
		const ids = await Promise.all(Array.from({ length: 3 }, () => storage.mintId<EntryId>()));
		await storage.commit(
			ids.map((id) => ({ type: "entry", value: entry(id) })),
			context,
		);
		const first = await storage.scanEntries({ conversationId: ROOT }, 2, undefined, context);
		a.deepEqual(
			first.items.map((item) => item.id),
			[ids[2], ids[1]],
		);
		await storage.commit([{ type: "entry", value: entry(await storage.mintId<EntryId>()) }], context);
		const second = await storage.scanEntries({ conversationId: ROOT }, 2, first.next, context);
		a.deepEqual(
			second.items.map((item) => item.id),
			[ids[0]],
		);
		a.strictEqual(second.next, undefined);
	});
	seeded("paginates conversations by opaque cursor in ascending ID order", async (storage) => {
		const ids = await Promise.all([storage.mintId<ConversationId>(), storage.mintId<ConversationId>()]);
		await storage.commit(
			[...ids].reverse().map((id) => ({ type: "conversation", value: { id } })),
			context,
		);
		const first = await storage.scanConversations({}, 2, undefined, context);
		a.deepEqual(
			first.items.map((item) => item.id),
			[ROOT, ids[0]],
		);
		a.ok(first.next);
		const next = await storage.scanConversations({}, 2, JSON.parse(JSON.stringify(first.next)), context);
		a.deepEqual(
			next.items.map((item) => item.id),
			[ids[1]],
		);
		a.strictEqual(next.next, undefined);
	});
	seeded("filters and pages conversations by durable owner edges", async (storage) => {
		const other = await storage.mintId<ConversationId>(),
			t1 = await storage.mintId<TaskId<JsonValue>>(),
			t2 = await storage.mintId<TaskId<JsonValue>>();
		const ids = await Promise.all(Array.from({ length: 3 }, () => storage.mintId<ConversationId>()));
		await storage.commit(
			[
				{ type: "conversation", value: { id: other } },
				...ids.map(
					(id, index): StorageWrite => ({
						type: "conversation",
						value: { id, owner: { conversationId: index === 2 ? other : ROOT, taskId: index === 1 ? t2 : t1 } },
					}),
				),
			],
			context,
		);
		const scan = async (query: { ownerConversationId?: ConversationId; ownerTaskId?: TaskId }) =>
			(await all((cursor) => storage.scanConversations(query, 1, cursor, context))).map((item) => item.id);
		const query = { ownerConversationId: ROOT };
		const first = await storage.scanConversations(query, 1, undefined, context);
		a.deepEqual(
			first.items.map((item) => item.id),
			[ids[0]],
		);
		a.ok(first.next);
		const second = await storage.scanConversations(query, 1, first.next, context);
		a.deepEqual(
			second.items.map((item) => item.id),
			[ids[1]],
		);
		a.strictEqual(second.next, undefined);
		a.deepEqual(await scan({ ownerConversationId: ROOT }), ids.slice(0, 2));
		a.deepEqual(await scan({ ownerTaskId: t1 }), [ids[0], ids[2]]);
		a.deepEqual(await scan({ ownerConversationId: ROOT, ownerTaskId: t1 }), [ids[0]]);
	});
	seeded("scans deep fork history newest-first through every ancestor cap", async (storage) => {
		const r1 = await storage.mintId<EntryId>(),
			r2 = await storage.mintId<EntryId>(),
			excluded = await storage.mintId<EntryId>();
		const seq = await storage.commit(
			[
				{ type: "entry", value: entry(r1) },
				{ type: "entry", value: entry(r2, ROOT, { head: r1 }) },
				{ type: "entry", value: entry(excluded) },
			],
			context,
		);
		const child = await storage.mintId<ConversationId>();
		await storage.commit(
			[{ type: "conversation", value: { id: child, parent: { conversationId: ROOT, at: r2 } } }],
			context,
		);
		const c1 = await storage.mintId<EntryId>(),
			c2 = await storage.mintId<EntryId>();
		await storage.commit(
			[
				{ type: "entry", value: entry(c1, child) },
				{ type: "entry", value: entry(c2, child) },
			],
			context,
		);
		const grand = await storage.mintId<ConversationId>();
		const laterRoot = await storage.mintId<EntryId>();
		await storage.commit([{ type: "entry", value: entry(laterRoot) }], context);
		await storage.commit(
			[{ type: "conversation", value: { id: grand, parent: { conversationId: child, at: c1 } } }],
			context,
		);
		const g1 = await storage.mintId<EntryId>(),
			g2 = await storage.mintId<EntryId>();
		const grandSeq = await storage.commit(
			[
				{ type: "entry", value: entry(g1, grand, { head: g1 }) },
				{ type: "entry", value: entry(g2, grand) },
			],
			context,
		);
		const laterChild = await storage.mintId<EntryId>();
		await storage.commit([{ type: "entry", value: entry(laterChild, child) }], context);
		const firstDown = await storage.scanEntries({ conversationId: grand }, 2, undefined, context);
		const secondDown = await storage.scanEntries({ conversationId: grand }, 2, firstDown.next, context);
		const thirdDown = await storage.scanEntries({ conversationId: grand }, 2, secondDown.next, context);
		a.deepEqual(
			firstDown.items.map((item) => item.id),
			[g2, g1],
		);
		a.deepEqual(
			secondDown.items.map((item) => item.id),
			[c1, r2],
		);
		a.deepEqual(
			thirdDown.items.map((item) => item.id),
			[r1],
		);
		a.strictEqual(thirdDown.next, undefined);
		a.deepEqual(
			(await all((cursor) => storage.scanEntries({ conversationId: grand }, 2, cursor, context))).map(
				(item) => item.id,
			),
			[g2, g1, c1, r2, r1],
		);
		a.deepEqual(
			(
				await all((cursor) => storage.scanEntries({ conversationId: grand, order: "ascending" }, 2, cursor, context))
			).map((item) => item.id),
			[r1, r2, c1, g1, g2],
		);
		const ascending = { conversationId: grand, order: "ascending" } as const;
		const firstUp = await storage.scanEntries(ascending, 2, undefined, context);
		const secondUp = await storage.scanEntries(ascending, 2, firstUp.next, context);
		const thirdUp = await storage.scanEntries({ conversationId: grand }, 2, secondUp.next, context);
		a.deepEqual(
			firstUp.items.map((item) => item.id),
			[r1, r2],
		);
		a.deepEqual(
			secondUp.items.map((item) => item.id),
			[c1, g1],
		);
		a.deepEqual(
			thirdUp.items.map((item) => item.id),
			[g2],
		);
		a.strictEqual(thirdUp.next, undefined);
		await a.rejects(
			storage.scanEntries({ conversationId: grand, order: "descending" }, 2, firstUp.next, context),
			"cursor",
		);
		a.deepEqual(
			(await storage.scanEntries({ ...ascending, minEntryId: r2, maxEntryId: c1 }, 10, undefined, context)).items.map(
				(item) => item.id,
			),
			[r2, c1],
		);
		a.deepEqual(
			(
				await storage.scanEntries({ conversationId: grand, minEntryId: r2, maxEntryId: c1 }, 10, undefined, context)
			).items.map((item) => item.id),
			[c1, r2],
		);
		a.strictEqual((await storage.findLatestHeadMarker(grand, undefined, context))?.id, g1);
		a.strictEqual((await storage.findLatestHeadMarker(grand, undefined, context))?.head, g1);
		a.strictEqual((await storage.findLatestHeadMarker(grand, c1, context))?.id, r2);
		a.strictEqual((await storage.findLatestHeadMarker(grand, c1, context))?.head, r1);
		a.strictEqual(await storage.findLatestHeadMarker(grand, r1, context), undefined);
		const tailQuery = { conversationId: grand, minEntryId: g1 };
		const tail = await storage.scanEntries(tailQuery, 1, undefined, context);
		a.deepEqual(
			tail.items.map((item) => item.id),
			[g2],
		);
		a.ok(tail.next);
		const head = await storage.scanEntries(tailQuery, 1, tail.next, context);
		a.deepEqual(
			head.items.map((item) => item.id),
			[g1],
		);
		a.strictEqual(head.next, undefined);
		a.deepEqual(
			(
				await storage.scanEntries({ conversationId: grand, minEntryId: r1, maxEntryId: c1 }, 10, undefined, context)
			).items.map((item) => item.id),
			[c1, r2, r1],
		);
		a.deepEqual(await storage.entry(r1, context), { entry: entry(r1), commitSeq: seq });
		a.deepEqual(await storage.entry(grand, r1, context), { entry: entry(r1), commitSeq: seq });
		a.strictEqual((await storage.entry(r2, context))?.commitSeq, seq);
		a.strictEqual((await storage.entry(g1, context))?.commitSeq, grandSeq);
		a.strictEqual((await storage.entry(grand, g2, context))?.commitSeq, grandSeq);
		a.strictEqual((await storage.entry(grand, c1, context))?.entry.conversationId, child);
		a.strictEqual(await storage.entry(grand, excluded, context), undefined);
		a.strictEqual(await storage.entry(grand, c2, context), undefined);
		a.strictEqual(await storage.entry(grand, laterRoot, context), undefined);
		a.strictEqual(await storage.entry(grand, laterChild, context), undefined);
		a.strictEqual(await storage.entry(idFromNumber<EntryId>(999999), context), undefined);
		a.strictEqual(await storage.entry(grand, idFromNumber<EntryId>(999999), context), undefined);
		a.strictEqual(await storage.entry(ROOT, g1, context), undefined);
		await a.rejects(storage.entry(idFromNumber<ConversationId>(999999), r1, context), "Unknown conversation");
		await a.rejects(
			storage.scanEntries({ conversationId: idFromNumber<ConversationId>(999999) }, 2, undefined, context),
			"Unknown conversation",
		);
	});
	seeded("scans tables in either ID order and continues a cursor in its order", async (storage) => {
		const conversations = [ROOT],
			tasks: TaskId<JsonValue>[] = [],
			submissions: SubmissionId[] = [];
		for (let index = 0; index < 3; index++) {
			const cid = await storage.mintId<ConversationId>(),
				tid = await storage.mintId<TaskId<JsonValue>>(),
				sid = await storage.mintId<SubmissionId>();
			conversations.push(cid);
			tasks.push(tid);
			submissions.push(sid);
			await storage.commit(
				[
					{ type: "conversation", value: { id: cid } },
					{ type: "task", value: pending(tid) },
					{ type: "submission", value: { id: sid, conversationId: ROOT, type: "input", status: "queued" } },
				],
				context,
			);
		}
		type Scan = (
			order: ScanOrder | undefined,
			cursor: Cursor | undefined,
		) => Promise<Page<{ readonly id: number }, Cursor>>;
		const scans: [Scan, readonly number[]][] = [
			[(order, cursor) => storage.scanConversations({ order }, 2, cursor, context), conversations],
			[(order, cursor) => storage.scanTasks({ order }, 2, cursor, context), tasks],
			[(order, cursor) => storage.scanSubmissions({ order }, 2, cursor, context), submissions],
		];
		for (const [scan, ids] of scans)
			for (const order of [undefined, "ascending", "descending"] as const) {
				const first = await scan(order, undefined);
				a.deepEqual(
					first.items.map((item) => item.id),
					order === "descending" ? [...ids].reverse().slice(0, 2) : ids.slice(0, 2),
				);
				const rest = await all((cursor) =>
					scan(undefined, cursor === undefined ? JSON.parse(JSON.stringify(first.next)) : cursor),
				);
				a.deepEqual(
					[...first.items, ...rest].map((item) => item.id),
					order === "descending" ? [...ids].reverse() : ids,
				);
				a.deepEqual(
					(await scan(order, first.next)).items.map((item) => item.id),
					(order === "descending" ? [...ids].reverse() : ids).slice(2, 4),
				);
				await a.rejects(scan(order === "descending" ? "ascending" : "descending", first.next), "cursor");
			}
	});
	seeded("replaces complete task records and pages filtered task scans", async (storage) => {
		const ids = await Promise.all(Array.from({ length: 3 }, () => storage.mintId<TaskId<JsonValue>>()));
		const records = [
			pending(ids[0]!, { memos: { keep: 1 } }),
			pending(ids[1]!, { background: true }),
			pending(ids[2]!, { abortRequested: true }),
		];
		await storage.commit(
			records.map((value) => ({ type: "task", value })),
			context,
		);
		const running: StoredTask = {
			...records[0]!,
			abortRequested: true,
			state: { status: "running", checkpoint: { phase: "effect", attempt: 1 } },
		};
		await storage.commit([{ type: "task", value: running }], context);
		a.deepEqual(await storage.task(ids[0]!, context), running);
		const { memos: _memos, ...base } = running;
		const terminal: StoredTask = {
			...base,
			state: { status: "terminal", outcome: { status: "completed", result: { entryId: 99 } } },
		};
		await storage.commit([{ type: "task", value: terminal }], context);
		a.deepEqual(await storage.task(ids[0]!, context), terminal);
		const page = await storage.scanTasks({ status: "pending" }, 1, undefined, context);
		a.deepEqual(
			page.items.map((item) => item.id),
			[ids[1]],
		);
		a.ok(page.next);
		a.deepEqual(
			(await storage.scanTasks({ status: "pending" }, 1, page.next, context)).items.map((item) => item.id),
			[ids[2]],
		);
		a.deepEqual(
			(await all((cursor) => storage.scanTasks({ status: "pending" }, 1, cursor, context))).map((item) => item.id),
			ids.slice(1),
		);
		a.deepEqual((await storage.scanTasks({ status: "terminal", abortRequested: true }, 10, undefined, context)).items, [
			terminal,
		]);
		a.deepEqual(
			(await storage.scanTasks({ background: true }, 10, undefined, context)).items.map((item) => item.id),
			[ids[1]],
		);
	});
	seeded("stores owners and scans waiting and completing tasks by status", async (storage) => {
		const owner = await storage.mintId<TaskId<JsonValue>>(),
			waiting = await storage.mintId<TaskId<JsonValue>>(),
			completing = await storage.mintId<TaskId<JsonValue>>();
		const records = [
			pending(owner),
			pending(waiting, {
				owner,
				memos: { keep: true },
				state: { status: "waiting", checkpoint: { phase: "next" }, on: [owner], policy: "allSettled" },
			}),
			pending(completing, {
				owner,
				state: { status: "completing", outcome: { status: "failed", error: { message: "held" } } },
			}),
		];
		await storage.commit(
			records.map((value) => ({ type: "task", value })),
			context,
		);
		for (const value of records) {
			a.deepEqual(await storage.task(value.id, context), value);
			a.deepEqual((await storage.scanTasks({ status: value.state.status }, 10, undefined, context)).items, [value]);
		}
		await storage.commit(
			[
				{
					type: "task",
					value: pending(completing, {
						owner,
						state: { status: "terminal", outcome: { status: "failed", error: { message: "held" } } },
					}),
				},
			],
			context,
		);
		a.deepEqual((await storage.scanTasks({ status: "completing" }, 10, undefined, context)).items, []);
		a.deepEqual((await storage.scanTasks({ status: "terminal" }, 10, undefined, context)).items, [
			pending(completing, {
				owner,
				state: { status: "terminal", outcome: { status: "failed", error: { message: "held" } } },
			}),
		]);
	});
	seeded("stores and scans sleeping tasks by status", async (storage) => {
		const id = await storage.mintId<TaskId<JsonValue>>();
		const sleeping = pending(id, {
			state: { status: "sleeping", checkpoint: { phase: "next" }, until: 61000 },
			memos: { keep: true },
		});
		await storage.commit([{ type: "task", value: sleeping }], context);
		a.deepEqual(await storage.task(id, context), sleeping);
		a.deepEqual((await storage.scanTasks({ status: "sleeping" }, 10, undefined, context)).items, [sleeping]);
		const running = pending(id, { state: { status: "running", checkpoint: { phase: "next" } } });
		await storage.commit([{ type: "task", value: running }], context);
		a.deepEqual((await storage.scanTasks({ status: "sleeping" }, 10, undefined, context)).items, []);
		a.deepEqual((await storage.scanTasks({ status: "running" }, 10, undefined, context)).items, [running]);
	});
	seeded("indexes request IDs per conversation and replaces complete submission records", async (storage) => {
		const other = await storage.mintId<ConversationId>();
		await storage.commit([{ type: "conversation", value: { id: other } }], context);
		const ids = await Promise.all(Array.from({ length: 3 }, () => storage.mintId<SubmissionId>()));
		const records: SubmissionRecord[] = ids.map((id, index) => ({
			id,
			conversationId: index === 2 ? other : ROOT,
			requestId: index === 1 ? "other" : "same",
			type: "input",
			status: "queued",
		}));
		await storage.commit(
			records.map((value) => ({ type: "submission", value })),
			context,
		);
		a.deepEqual(await storage.submissionByRequest(ROOT, "same", context), records[0]);
		a.deepEqual(await storage.submissionByRequest(other, "same", context), records[2]);
		const changed: SubmissionRecord = {
			id: ids[1]!,
			conversationId: ROOT,
			requestId: "other",
			type: "input",
			status: "placed",
			entry: await storage.mintId<EntryId>(),
		};
		await storage.commit([{ type: "submission", value: changed }], context);
		a.deepEqual(await storage.submission(ids[1]!, context), changed);
		a.deepEqual(await storage.submissionByRequest(ROOT, "other", context), changed);
		const scan = async (query: { conversationId?: ConversationId; status?: SubmissionRecord["status"] }) =>
			(await all((cursor) => storage.scanSubmissions(query, 1, cursor, context))).map((item) => item.id);
		a.deepEqual(await scan({}), ids);
		a.deepEqual(await scan({ conversationId: ROOT }), ids.slice(0, 2));
		a.deepEqual(await scan({ status: "placed" }), [ids[1]]);
		a.deepEqual(await scan({ conversationId: other, status: "queued" }), [ids[2]]);
		a.deepEqual(
			(await all((cursor) => storage.scanSubmissions({ status: "queued" }, 1, cursor, context))).map((item) => item.id),
			[ids[0], ids[2]],
		);
		a.deepEqual(
			(await storage.scanSubmissions({ conversationId: ROOT, status: "placed" }, 10, undefined, context)).items,
			[changed],
		);
		a.deepEqual(
			(await storage.scanSubmissions({ conversationId: other, status: "placed" }, 10, undefined, context)).items,
			[],
		);
	});
	seeded("stores passive write submissions without input-only lifecycle states", async (storage) => {
		const first = await storage.mintId<SubmissionId>(),
			second = await storage.mintId<SubmissionId>();
		const queued: SubmissionRecord[] = [first, second].map((id) => ({
			id,
			conversationId: ROOT,
			requestId: String(id),
			type: "write",
			status: "queued",
		}));
		await storage.commit(
			queued.map((value) => ({ type: "submission", value })),
			context,
		);
		const finished: SubmissionRecord[] = [
			{
				id: first,
				conversationId: ROOT,
				requestId: String(first),
				type: "write",
				status: "done",
				entry: await storage.mintId<EntryId>(),
			},
			{
				id: second,
				conversationId: ROOT,
				requestId: String(second),
				type: "write",
				status: "unanswered",
				reason: "closed",
				detail: { retryable: false },
			},
		];
		await storage.commit(
			finished.map((value) => ({ type: "submission", value })),
			context,
		);
		for (const value of finished) {
			a.deepEqual(await storage.submission(value.id, context), value);
			a.deepEqual(await storage.submissionByRequest(ROOT, value.requestId!, context), value);
		}
	});
	seeded("reconstructs rewindable documents and preserves half-open incarnations", async (storage) => {
		const id = await storage.mintId<DocumentId>(),
			next = await storage.mintId<DocumentId>();
		const record: DocumentCreate = {
			id,
			kind: "history",
			scope: { kind: "conversation", conversationId: ROOT },
			history: "rewindable",
			fork: "asOf",
		};
		const initial = { items: ["one"], nested: { count: 1 } };
		const appended = ["two"];
		const created = await storage.commit(
			[
				{
					type: "document.create",
					record,
					content: { kind: "base", version: 1, value: initial },
				},
			],
			context,
		);
		const changed = await storage.commit(
			[
				{
					type: "document.change",
					id,
					content: {
						kind: "delta",
						version: 1,
						ops: [
							["p", ["items"], 1, 0, appended],
							["s", ["nested", "count"], 2],
						],
					},
				},
			],
			context,
		);
		initial.items.push("caller mutation");
		appended.push("caller mutation");
		a.partialDeepEqual(await storage.document(id, created, context), {
			version: 1,
			deltasSinceBase: 0,
			value: { items: ["one"], nested: { count: 1 } },
		});
		const observed = await storage.document(id, changed, context);
		a.deepEqual(observed?.value, { items: ["one", "two"], nested: { count: 2 } });
		const items = observed?.value.items;
		if (!Array.isArray(items)) throw new Error("Expected stored document items");
		items.push("read mutation");
		a.deepEqual((await storage.document(id, "current", context))?.value, {
			items: ["one", "two"],
			nested: { count: 2 },
		});
		const checkpoint = await storage.commit(
			[{ type: "document.change", id, content: { kind: "base", version: 2, value: { count: 3 } } }],
			context,
		);
		const replaced = await storage.commit(
			[{ type: "document.change", id, content: { kind: "delta", version: 2, ops: [["r", { count: 4 }]] } }],
			context,
		);
		a.partialDeepEqual(await storage.document(id, created, context), {
			version: 1,
			deltasSinceBase: 0,
			value: { items: ["one"], nested: { count: 1 } },
		});
		a.partialDeepEqual(await storage.document(id, changed, context), {
			version: 1,
			deltasSinceBase: 1,
			value: { items: ["one", "two"], nested: { count: 2 } },
		});
		a.partialDeepEqual(await storage.document(id, checkpoint, context), {
			version: 2,
			deltasSinceBase: 0,
			value: { count: 3 },
		});
		a.partialDeepEqual(await storage.document(id, replaced, context), {
			version: 2,
			deltasSinceBase: 1,
			value: { count: 4 },
		});
		const retired = await storage.commit(
			[
				{
					type: "document.create",
					record: { ...record, id: next },
					content: { kind: "base", version: 1, value: { count: 5 } },
				},
				{ type: "document.retire", id },
				{ type: "document.change", id, content: { kind: "delta", version: 2, ops: [["s", ["retiring"], true]] } },
			],
			context,
		);
		a.strictEqual((await storage.findDocument({ kind: record.kind, scope: record.scope }, changed, context))?.id, id);
		a.strictEqual((await storage.findDocument({ kind: record.kind, scope: record.scope }, retired, context))?.id, next);
		a.partialDeepEqual(await storage.findDocument({ kind: record.kind, scope: record.scope }, retired, context), {
			id: next,
			createdAt: retired,
		});
		a.deepEqual(
			(await storage.scanDocuments({ scope: record.scope, at: changed }, 10, undefined, context)).items.map(
				(item) => item.id,
			),
			[id],
		);
		a.deepEqual((await storage.document(next, "current", context))?.value, { count: 5 });
		a.strictEqual(await storage.document(id, retired, context), undefined);
		a.deepEqual(
			(await storage.scanDocuments({ scope: record.scope, at: retired }, 10, undefined, context)).items.map(
				(item) => item.id,
			),
			[next],
		);
	});
	seeded("streams long document tails across root replacement deltas", async (storage) => {
		const id = await storage.mintId<DocumentId>();
		const record: DocumentCreate = {
			id,
			kind: "tail",
			scope: { kind: "conversation", conversationId: ROOT },
			history: "rewindable",
			fork: "asOf",
		};
		const initial = {
			revision: 0,
			rows: Array.from({ length: 512 }, (_, value) => ({ value, stable: String(value) })),
		};
		const created = await storage.commit(
			[{ type: "document.create", record, content: { kind: "base", version: 1, value: initial } }],
			context,
		);
		let at = created;
		const before = structuredClone(initial);
		for (let revision = 1; revision <= 24; revision++) {
			const index = (revision * 17) % 512;
			before.rows[index]!.value = -revision;
			before.revision = revision;
			at = await storage.commit(
				[
					{
						type: "document.change",
						id,
						content: {
							kind: "delta",
							version: 1,
							ops: [
								["s", ["rows", index, "value"], -revision],
								["s", ["revision"], revision],
							],
						},
					},
				],
				context,
			);
		}
		const replacement = {
			revision: 100,
			rows: initial.rows.map((row, index) => ({ value: 10000 + index, stable: row.stable })),
		};
		const expected = structuredClone(replacement);
		const replaced = await storage.commit(
			[{ type: "document.change", id, content: { kind: "delta", version: 1, ops: [["r", replacement]] } }],
			context,
		);
		replacement.rows[0]!.value = -999;
		for (let revision = 101; revision <= 124; revision++) {
			const index = (revision * 19) % 512;
			expected.rows[index]!.value = -revision;
			expected.revision = revision;
			await storage.commit(
				[
					{
						type: "document.change",
						id,
						content: {
							kind: "delta",
							version: 1,
							ops: [
								["s", ["rows", index, "value"], -revision],
								["s", ["revision"], revision],
							],
						},
					},
				],
				context,
			);
		}
		a.deepEqual((await storage.document(id, created, context))?.value, initial);
		a.deepEqual((await storage.document(id, at, context))?.value, before);
		a.deepEqual((await storage.document(id, replaced, context))?.value, {
			...initial,
			revision: 100,
			rows: initial.rows.map((row, index) => ({ value: 10000 + index, stable: row.stable })),
		});
		a.deepEqual((await storage.document(id, "current", context))?.value, expected);
		const read = await storage.document(id, "current", context);
		const rows = read?.value.rows;
		if (Array.isArray(rows)) object(rows[0]).value = -1000;
		a.deepEqual((await storage.document(id, "current", context))?.value, expected);
	});
	seeded("copies stored document bases independently and rejects ambiguous sources", async (storage) => {
		const child = await storage.mintId<ConversationId>(),
			otherChild = await storage.mintId<ConversationId>();
		await storage.commit(
			[
				{ type: "conversation", value: { id: child } },
				{ type: "conversation", value: { id: otherChild } },
			],
			context,
		);
		const source = await storage.mintId<DocumentId>(),
			historical = await storage.mintId<DocumentId>(),
			current = await storage.mintId<DocumentId>(),
			retired = await storage.mintId<DocumentId>();
		const record: DocumentCreate = {
			id: source,
			kind: "copy",
			scope: { kind: "conversation", conversationId: ROOT },
			history: "rewindable",
			fork: "asOf",
		};
		const created = await storage.commit(
			[
				{
					type: "document.create",
					record,
					content: { kind: "base", version: 2, value: { count: 1, rows: [{ value: "base" }] } },
				},
			],
			context,
		);
		await storage.commit(
			[
				{
					type: "document.change",
					id: source,
					content: {
						kind: "delta",
						version: 2,
						ops: [
							["s", ["count"], 2],
							["p", ["rows"], 1, 0, [{ value: "current" }]],
						],
					},
				},
			],
			context,
		);
		await storage.commit(
			[
				{
					type: "document.copy",
					record: { ...record, id: historical, scope: { kind: "conversation", conversationId: child } },
					source: { id: source, at: created },
				},
				{
					type: "document.copy",
					record: { ...record, id: current, scope: { kind: "conversation", conversationId: otherChild } },
					source: { id: source, at: "current" },
				},
				{
					type: "document.copy",
					record: { ...record, id: retired },
					source: { id: source, at: "current" },
				},
				{ type: "document.retire", id: retired },
			],
			context,
		);
		a.partialDeepEqual(await storage.document(historical, "current", context), {
			version: 2,
			value: { count: 1, rows: [{ value: "base" }] },
		});
		a.partialDeepEqual(await storage.document(current, "current", context), {
			version: 2,
			value: { count: 2, rows: [{ value: "base" }, { value: "current" }] },
		});
		a.strictEqual(await storage.document(retired, "current", context), undefined);
		await storage.commit(
			[
				{ type: "document.change", id: source, content: { kind: "base", version: 2, value: { count: 99 } } },
				{ type: "document.retire", id: source },
			],
			context,
		);
		a.deepEqual((await storage.document(historical, "current", context))?.value, {
			count: 1,
			rows: [{ value: "base" }],
		});
		a.deepEqual((await storage.document(current, "current", context))?.value, {
			count: 2,
			rows: [{ value: "base" }, { value: "current" }],
		});
		const conflict = await storage.mintId<DocumentId>();
		const conflictError = await storage
			.commit(
				[
					{
						type: "document.copy",
						record: { ...record, id: conflict, scope: { kind: "conversation", conversationId: otherChild } },
						source: { id: current, at: "current" },
					},
					{ type: "document.retire", id: current },
				],
				context,
			)
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		a.strictEqual(conflictError instanceof Error, true);
		a.strictEqual(await storage.document(conflict, "current", context), undefined);
		a.deepEqual((await storage.document(current, "current", context))?.value, {
			count: 2,
			rows: [{ value: "base" }, { value: "current" }],
		});
		const mismatch = await storage.mintId<DocumentId>();
		const mismatchError = await storage
			.commit(
				[
					{
						type: "document.copy",
						record: { ...record, id: mismatch, kind: "different" },
						source: { id: current, at: "current" },
					},
				],
				context,
			)
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		a.strictEqual(mismatchError instanceof Error, true);
		a.strictEqual(await storage.document(mismatch, "current", context), undefined);
		const latest = await storage.mintId<DocumentId>(),
			copied = await storage.mintId<DocumentId>();
		const latestRecord: DocumentCreate = {
			id: latest,
			kind: "copy.latest",
			scope: { kind: "conversation", conversationId: ROOT },
			history: "latest",
			fork: "current",
		};
		await storage.commit(
			[
				{
					type: "document.create",
					record: latestRecord,
					content: { kind: "base", version: 4, value: { retained: "copy" } },
				},
			],
			context,
		);
		await storage.commit(
			[
				{
					type: "document.copy",
					record: { ...latestRecord, id: copied, scope: { kind: "conversation", conversationId: child } },
					source: { id: latest, at: "current" },
				},
			],
			context,
		);
		await storage.commit(
			[
				{ type: "document.change", id: latest, content: { kind: "base", version: 4, value: { retained: "source" } } },
				{ type: "document.retire", id: latest },
			],
			context,
		);
		a.partialDeepEqual(await storage.document(copied, "current", context), { version: 4, value: { retained: "copy" } });
	});
	seeded(
		"uses bases for version transitions and rejects historical reads of current-only documents",
		async (storage) => {
			const id = await storage.mintId<DocumentId>();
			await storage.commit(
				[
					{
						type: "document.create",
						record: { id, kind: "settings", scope: { kind: "session" } },
						content: { kind: "base", version: 1, value: { count: 1 } },
					},
				],
				context,
			);
			await storage.commit(
				[{ type: "document.change", id, content: { kind: "delta", version: 1, ops: [["s", ["count"], 2]] } }],
				context,
			);
			const changed = await storage.commit(
				[{ type: "document.change", id, content: { kind: "base", version: 2, value: { count: 3 } } }],
				context,
			);
			a.partialDeepEqual(await storage.document(id, "current", context), { version: 2, value: { count: 3 } });
			await a.rejects(storage.document(id, changed, context), "does not retain historical content");
			await a.rejects(
				storage.commit([{ type: "document.change", id, content: { kind: "delta", version: 1, ops: [] } }], context),
				"version transition requires a base",
			);
			a.deepEqual((await storage.document(id, "current", context))?.value, { count: 3 });
			await storage.commit([{ type: "document.retire", id }], context);
			a.strictEqual(await storage.document(id, "current", context), undefined);
		},
	);
	seeded("indexes logical addresses and exact-scope scans independently", async (storage) => {
		const task = await storage.mintId<TaskId<JsonValue>>();
		await storage.commit([{ type: "task", value: pending(task) }], context);
		const records: DocumentCreate[] = [];
		for (const scope of [
			{ kind: "session" },
			{ kind: "conversation", conversationId: ROOT },
			{ kind: "task", taskId: task },
		] as const)
			for (const key of [undefined, "__proto__", "constructor"]) {
				const id = await storage.mintId<DocumentId>();
				const record: DocumentCreate =
					scope.kind === "conversation"
						? { id, kind: "cache", key, scope, history: "latest", fork: "current" }
						: scope.kind === "session"
							? { id, kind: "cache", key, scope: { kind: "session" } }
							: { id, kind: "cache", key, scope: { kind: "task", taskId: scope.taskId } };
				records.push(record);
				const created = await storage.commit(
					[{ type: "document.create", record, content: { kind: "base", version: 1, value: { owner: id } } }],
					context,
				);
				if (scope.kind === "task")
					await a.rejects(storage.document(id, created, context), "does not retain historical content");
			}
		const other = await storage.mintId<DocumentId>();
		await storage.commit(
			[
				{
					type: "document.create",
					record: { id: other, kind: "other", scope: { kind: "task", taskId: task } },
					content: { kind: "base", version: 1, value: {} },
				},
			],
			context,
		);
		for (const record of records)
			a.strictEqual(
				(await storage.findDocument({ kind: record.kind, key: record.key, scope: record.scope }, "current", context))
					?.id,
				record.id,
			);
		for (const scope of records.map((record) => record.scope)) {
			a.deepEqual(
				(await all((cursor) => storage.scanDocuments({ scope, at: "current", kind: "cache" }, 1, cursor, context))).map(
					(item) => item.id,
				),
				records.filter((record) => JSON.stringify(record.scope) === JSON.stringify(scope)).map((record) => record.id),
			);
			a.deepEqual(
				(await all((cursor) => storage.scanDocuments({ scope, at: "current" }, 1, cursor, context))).map(
					(item) => item.id,
				),
				[
					...records
						.filter((record) => JSON.stringify(record.scope) === JSON.stringify(scope))
						.map((record) => record.id),
					...(scope.kind === "task" ? [other] : []),
				],
			);
		}
	});
	seeded("keeps document lifecycle failures atomic and gives create-plus-retire an empty lifetime", async (storage) => {
		const id = await storage.mintId<DocumentId>(),
			next = await storage.mintId<DocumentId>();
		const record: DocumentCreate = { id, kind: "singleton", scope: { kind: "session" } };
		await storage.commit(
			[{ type: "document.create", record, content: { kind: "base", version: 1, value: { count: 1 } } }],
			context,
		);
		await a.rejects(
			storage.commit(
				[
					{
						type: "document.create",
						record: { ...record, id: next },
						content: { kind: "base", version: 1, value: { count: 2 } },
					},
					{ type: "document.change", id, content: { kind: "delta", version: 1, ops: [] } },
				],
				context,
			),
			"current incarnation",
		);
		a.deepEqual((await storage.document(id, "current", context))?.value, { count: 1 });
		a.strictEqual(await storage.document(next, "current", context), undefined);
		const empty = await storage.mintId<DocumentId>();
		const at = await storage.commit(
			[
				{
					type: "document.create",
					record: {
						id: empty,
						kind: "empty",
						scope: { kind: "conversation", conversationId: ROOT },
						history: "rewindable",
						fork: "initial",
					},
					content: { kind: "base", version: 1, value: {} },
				},
				{ type: "document.retire", id: empty },
			],
			context,
		);
		a.strictEqual(await storage.document(empty, at, context), undefined);
		a.strictEqual(await storage.document(empty, "current", context), undefined);
		a.strictEqual(
			await storage.findDocument({ kind: "empty", scope: { kind: "conversation", conversationId: ROOT } }, at, context),
			undefined,
		);
	});
	seeded("rolls back record tables and secondary indexes when a document command fails", async (storage) => {
		const tid = await storage.mintId<TaskId<JsonValue>>(),
			sid = await storage.mintId<SubmissionId>(),
			did = await storage.mintId<DocumentId>();
		const task = pending(tid),
			submission: SubmissionRecord = {
				id: sid,
				conversationId: ROOT,
				requestId: "atomic",
				type: "input",
				status: "queued",
			},
			record: DocumentCreate = { id: did, kind: "atomic", scope: { kind: "session" } };
		const before = await storage.commit(
			[
				{ type: "task", value: task },
				{ type: "submission", value: submission },
				{ type: "document.create", record, content: { kind: "base", version: 1, value: { count: 1 } } },
			],
			context,
		);
		const eid = await storage.mintId<EntryId>(),
			conflict = await storage.mintId<DocumentId>();
		await a.rejects(
			storage.commit(
				[
					{ type: "task", value: { ...task, state: { status: "running", checkpoint: { phase: "effect" } } } },
					{ type: "submission", value: { ...submission, status: "unanswered", reason: "failed" } },
					{ type: "entry", value: entry(eid) },
					{
						type: "document.create",
						record: { ...record, id: conflict },
						content: { kind: "base", version: 1, value: {} },
					},
				],
				context,
			),
			"current incarnation",
		);
		a.deepEqual(await storage.task(tid, context), task);
		a.deepEqual((await storage.scanTasks({ status: "pending" }, 10, undefined, context)).items, [task]);
		a.deepEqual(await storage.submissionByRequest(ROOT, "atomic", context), submission);
		a.strictEqual(await storage.entry(eid, context), undefined);
		a.strictEqual(await storage.document(conflict, "current", context), undefined);
		a.strictEqual(
			(await storage.findDocument({ kind: record.kind, scope: record.scope }, "current", context))?.id,
			did,
		);
		a.greaterThan(
			await storage.commit(
				[{ type: "document.change", id: did, content: { kind: "delta", version: 1, ops: [["s", ["count"], 3]] } }],
				context,
			),
			before,
		);
	});
	seeded("keeps indexed string identities lossless", async (storage) => {
		const saved: { key: string; tid: TaskId<JsonValue>; sid: SubmissionId; kindId: DocumentId; keyId: DocumentId }[] =
			[];
		for (const [index, key] of ["\ud800", "\ud801"].entries()) {
			const tid = await storage.mintId<TaskId<JsonValue>>(),
				sid = await storage.mintId<SubmissionId>(),
				kindId = await storage.mintId<DocumentId>(),
				keyId = await storage.mintId<DocumentId>();
			await storage.commit(
				[
					{ type: "task", value: pending(tid, { kind: key }) },
					{
						type: "submission",
						value: { id: sid, conversationId: ROOT, requestId: key, type: "input", status: "queued" },
					},
					{
						type: "document.create",
						record: { id: kindId, kind: key, scope: { kind: "session" } },
						content: { kind: "base", version: 1, value: { index } },
					},
					{
						type: "document.create",
						record: { id: keyId, kind: "family", key, scope: { kind: "session" } },
						content: { kind: "base", version: 1, value: { index } },
					},
				],
				context,
			);
			saved.push({ key, tid, sid, kindId, keyId });
		}
		for (const { key, tid, sid, kindId, keyId } of saved) {
			a.strictEqual((await storage.task(tid, context))?.kind, key);
			a.strictEqual((await storage.submissionByRequest(ROOT, key, context))?.requestId, key);
			a.deepEqual(
				(
					await storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind: key }, 10, undefined, context)
				).items.map((item) => item.id),
				[kindId],
			);
			a.deepEqual(
				(await storage.scanTasks({ kind: key }, 10, undefined, context)).items.map((item) => item.id),
				[tid],
			);
			a.strictEqual((await storage.submissionByRequest(ROOT, key, context))?.id, sid);
			a.strictEqual(
				(await storage.findDocument({ kind: key, scope: { kind: "session" } }, "current", context))?.id,
				kindId,
			);
			a.strictEqual(
				(await storage.findDocument({ kind: "family", key, scope: { kind: "session" } }, "current", context))?.id,
				keyId,
			);
		}
	});
	seeded("keeps one global record ID namespace and rejects exhausted ID minting", async (storage) => {
		const explicit = idFromNumber<EntryId>(100);
		await storage.commit([{ type: "entry", value: entry(explicit) }], context);
		a.strictEqual(await storage.mintId<EntryId>(), 101);
		await a.rejects(
			storage.commit([{ type: "task", value: pending(idFromNumber<TaskId<JsonValue>>(100)) }], context),
			"already belongs to entry",
		);
		await storage.commit([{ type: "entry", value: entry(idFromNumber<EntryId>(Number.MAX_SAFE_INTEGER)) }], context);
		await a.rejects(storage.mintId<EntryId>(), "ID space is exhausted");
		await a.rejects(storage.mintId<EntryId>(), "ID space is exhausted");
	});
	seeded("rejects every operation after close", async (storage) => {
		await storage.close(context);
		await a.rejects(storage.conversation(ROOT, context), "closed");
		await a.rejects(storage.commit([], context), "closed");
		await a.rejects(storage.mintId<ConversationId>(), "closed");
	});
	return cases;
}
