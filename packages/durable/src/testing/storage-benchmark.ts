import type { JsonValue } from "@axi/chord";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import {
	type ConversationId,
	type DocumentCreate,
	type DocumentId,
	type EntryId,
	type Seq,
	type Storage,
	type StorageWrite,
	type SubmissionId,
	type TaskId,
	type TaskRecord,
	ROOT_CONVERSATION_ID as ROOT,
} from "../types.ts";

export type StorageBenchmarkScale = {
	readonly name: string;
	readonly entryCount: number;
	readonly taskCount: number;
	readonly documentCount: number;
};
export const STORAGE_MEMORY_SCALES: readonly StorageBenchmarkScale[] = [
	{ name: "1k", entryCount: 1000, taskCount: 200, documentCount: 200 },
	{ name: "10k", entryCount: 10000, taskCount: 2000, documentCount: 2000 },
];
export const TIMING_SCALE: StorageBenchmarkScale = {
	name: "timing",
	entryCount: 1000,
	taskCount: 300,
	documentCount: 300,
};
const tails = [0, 16, 128, 1024] as const;
export type StorageBenchmarkDataset = {
	readonly firstEntryId: EntryId;
	readonly filteredTaskCount: number;
	readonly exactDocumentId: DocumentId;
	readonly exactDocumentKey: string;
	readonly replayDocumentIds: Readonly<Record<(typeof tails)[number], DocumentId>>;
	readonly historicalDocumentId: DocumentId;
	readonly ancientAt: Seq;
	readonly recentAt: Seq;
	readonly deepestConversationId: ConversationId;
	readonly ancestorHeadEntryId: EntryId;
};
export const storageBenchmarkPrimaryRecordCount = (scale: StorageBenchmarkScale): number =>
	1 + scale.entryCount + scale.taskCount + scale.documentCount + tails.length + 1 + 8 * 33;
function task(id: TaskId<JsonValue>, index: number): TaskRecord<JsonValue, JsonValue, JsonValue> {
	const base = {
		id,
		conversationId: ROOT,
		kind: index % 4 ? "benchmark.other" : "benchmark.filtered",
		version: 1,
		input: { index },
		background: index % 5 === 0,
		abortRequested: index % 7 === 0,
	};
	if (index % 3 === 2)
		return { ...base, state: { status: "terminal", outcome: { status: "completed", result: { index } } } };
	return {
		...base,
		state: { status: index % 3 ? "running" : "pending", checkpoint: { index, payload: "x".repeat(64) } },
	};
}
async function batches(
	count: number,
	storage: Storage,
	create: (index: number) => Promise<StorageWrite>,
): Promise<void> {
	for (let start = 0; start < count; start += 100) {
		const writes: StorageWrite[] = [];
		for (let index = start; index < Math.min(start + 100, count); index++) writes.push(await create(index));
		await storage.commit(writes, context);
	}
}
export async function seedStorageBenchmark(
	storage: Storage,
	scale: StorageBenchmarkScale = TIMING_SCALE,
): Promise<StorageBenchmarkDataset> {
	await storage.commit([{ type: "conversation", value: { id: ROOT } }], context);
	let firstEntryId: EntryId | undefined;
	await batches(scale.entryCount, storage, async (index) => {
		const id = await storage.mintId<EntryId>();
		if (index === 0) firstEntryId = id;
		return {
			type: "entry",
			value: {
				id,
				conversationId: ROOT,
				kind: "benchmark.entry",
				...(index === 0 ? { head: id } : {}),
				data: { index, text: `entry-${index}-${"x".repeat(96)}` },
			},
		};
	});
	await batches(scale.taskCount, storage, async (index) => ({
		type: "task",
		value: task(await storage.mintId<TaskId<JsonValue>>(), index),
	}));
	let exactDocumentId: DocumentId | undefined;
	await batches(scale.documentCount, storage, async (index) => {
		const id = await storage.mintId<DocumentId>();
		exactDocumentId = id;
		return {
			type: "document.create",
			record: { id, kind: "benchmark.family", key: `key-${index}`, scope: { kind: "session" } },
			content: { kind: "base", version: 1, value: { index, text: "x".repeat(128) } },
		};
	});
	const replay = await Promise.all(tails.map(async (tail) => ({ tail, id: await storage.mintId<DocumentId>() })));
	await storage.commit(
		replay.map(({ tail, id }) => ({
			type: "document.create",
			record: {
				id,
				kind: "benchmark.replay",
				key: String(tail),
				scope: { kind: "conversation", conversationId: ROOT },
				history: "rewindable",
				fork: "asOf",
			},
			content: { kind: "base", version: 1, value: { count: 0, text: "x".repeat(64) } },
		})),
		context,
	);
	for (let count = 1; count <= 1024; count++)
		await storage.commit(
			replay
				.filter(({ tail }) => tail >= count)
				.map(({ id }) => ({
					type: "document.change",
					id,
					content: { kind: "delta", version: 1, ops: [["s", ["count"], count]] },
				})),
			context,
		);
	const historicalDocumentId = await storage.mintId<DocumentId>();
	const record: DocumentCreate = {
		id: historicalDocumentId,
		kind: "benchmark.history",
		scope: { kind: "conversation", conversationId: ROOT },
		history: "rewindable",
		fork: "asOf",
	};
	await storage.commit(
		[{ type: "document.create", record, content: { kind: "base", version: 1, value: { count: 0 } } }],
		context,
	);
	let ancientAt: Seq | undefined;
	for (let count = 1; count <= 128; count++)
		ancientAt = await storage.commit(
			[
				{
					type: "document.change",
					id: historicalDocumentId,
					content: { kind: "delta", version: 1, ops: [["s", ["count"], count]] },
				},
			],
			context,
		);
	await storage.commit(
		[
			{
				type: "document.change",
				id: historicalDocumentId,
				content: { kind: "base", version: 1, value: { count: 128 } },
			},
		],
		context,
	);
	if (ancientAt === undefined) throw new Error("Benchmark history seed produced no commits");
	let recentAt = ancientAt;
	for (let count = 129; count <= 256; count++)
		recentAt = await storage.commit(
			[
				{
					type: "document.change",
					id: historicalDocumentId,
					content: { kind: "delta", version: 1, ops: [["s", ["count"], count]] },
				},
			],
			context,
		);
	if (firstEntryId === undefined) throw new Error("Benchmark scale must create entries");
	let deepestConversationId = ROOT;
	let at = firstEntryId;
	for (let depth = 0; depth < 8; depth++) {
		const id = await storage.mintId<ConversationId>();
		await storage.commit(
			[{ type: "conversation", value: { id, parent: { conversationId: deepestConversationId, at } } }],
			context,
		);
		const ids = await Promise.all(Array.from({ length: 32 }, () => storage.mintId<EntryId>()));
		await storage.commit(
			ids.map((entry, index) => ({
				type: "entry",
				value: { id: entry, conversationId: id, kind: "benchmark.fork", data: { depth, index } },
			})),
			context,
		);
		deepestConversationId = id;
		at = ids.at(-1)!;
	}
	if (exactDocumentId === undefined) throw new Error("Benchmark scale must create documents");
	return {
		firstEntryId,
		exactDocumentId,
		exactDocumentKey: `key-${scale.documentCount - 1}`,
		filteredTaskCount: Math.min(50, Math.ceil(scale.taskCount / 60)),
		replayDocumentIds: Object.fromEntries(replay.map(({ tail, id }) => [tail, id])) as Record<
			(typeof tails)[number],
			DocumentId
		>,
		historicalDocumentId,
		ancientAt,
		recentAt,
		deepestConversationId,
		ancestorHeadEntryId: firstEntryId,
	};
}

export type StorageReadBenchmark = {
	readonly name: string;
	run(storage: Storage, dataset: StorageBenchmarkDataset): Promise<number>;
	expected(dataset: StorageBenchmarkDataset): number;
};
export const STORAGE_READ_BENCHMARKS: readonly StorageReadBenchmark[] = [
	{
		name: "exact entry lookup",
		run: async (storage, data) => (await storage.entry(data.firstEntryId, context))?.entry.id ?? -1,
		expected: (data) => data.firstEntryId,
	},
	{
		name: "entry page scan (100)",
		run: async (storage) => (await storage.scanEntries({ conversationId: ROOT }, 100, undefined, context)).items.length,
		expected: () => 100,
	},
	{
		name: "filtered task scan (50)",
		run: async (storage) =>
			(
				await storage.scanTasks(
					{ kind: "benchmark.filtered", status: "pending", background: true },
					50,
					undefined,
					context,
				)
			).items.length,
		expected: (data) => data.filteredTaskCount,
	},
	{
		name: "exact document address among many",
		run: async (storage, data) =>
			(
				await storage.findDocument(
					{ kind: "benchmark.family", key: data.exactDocumentKey, scope: { kind: "session" } },
					"current",
					context,
				)
			)?.id ?? -1,
		expected: (data) => data.exactDocumentId,
	},
	...tails.map(
		(tail): StorageReadBenchmark => ({
			name: `document replay tail (${tail})`,
			run: async (storage, data) =>
				Number((await storage.document(data.replayDocumentIds[tail], "current", context))?.value.count),
			expected: () => tail,
		}),
	),
	{
		name: "ancient historical read before newer base",
		run: async (storage, data) =>
			Number((await storage.document(data.historicalDocumentId, data.ancientAt, context))?.value.count),
		expected: () => 128,
	},
	{
		name: "recent historical read after newer base",
		run: async (storage, data) =>
			Number((await storage.document(data.historicalDocumentId, data.recentAt, context))?.value.count),
		expected: () => 256,
	},
	{
		name: "fork-depth history scan (100)",
		run: async (storage, data) =>
			(await storage.scanEntries({ conversationId: data.deepestConversationId }, 100, undefined, context)).items.length,
		expected: () => 100,
	},
	{
		name: "fork-depth head lookup",
		run: async (storage, data) =>
			(await storage.findLatestHeadMarker(data.deepestConversationId, undefined, context))?.id ?? -1,
		expected: (data) => data.ancestorHeadEntryId,
	},
];
export type StorageWriteBenchmark = {
	readonly name: string;
	readonly expected: number;
	run(storage: Storage): Promise<number>;
};
export async function seedStorageWriteBenchmark(storage: Storage): Promise<void> {
	await storage.commit([{ type: "conversation", value: { id: ROOT } }], context);
	await storage.commit(
		await Promise.all(
			Array.from(
				{ length: 100 },
				async (_, index): Promise<StorageWrite> => ({
					type: "entry",
					value: {
						id: await storage.mintId<EntryId>(),
						conversationId: ROOT,
						kind: "benchmark.baseline",
						data: { index },
					},
				}),
			),
		),
		context,
	);
}
export const STORAGE_WRITE_BENCHMARKS: readonly StorageWriteBenchmark[] = [
	{
		name: "commit one entry",
		expected: 1,
		async run(storage) {
			const id = await storage.mintId<EntryId>();
			await storage.commit(
				[
					{
						type: "entry",
						value: { id, conversationId: ROOT, kind: "benchmark.write", data: { text: "x".repeat(128) } },
					},
				],
				context,
			);
			return 1;
		},
	},
	{
		name: "commit 100 entries",
		expected: 100,
		async run(storage) {
			const writes = await Promise.all(
				Array.from(
					{ length: 100 },
					async (_, index): Promise<StorageWrite> => ({
						type: "entry",
						value: {
							id: await storage.mintId<EntryId>(),
							conversationId: ROOT,
							kind: "benchmark.write",
							data: { index, text: "x".repeat(128) },
						},
					}),
				),
			);
			await storage.commit(writes, context);
			return writes.length;
		},
	},
	{
		name: "commit mixed entry/task/submission/document",
		expected: 4,
		async run(storage) {
			const entryId = await storage.mintId<EntryId>();
			const taskId = await storage.mintId<TaskId<JsonValue>>();
			const submissionId = await storage.mintId<SubmissionId>();
			const documentId = await storage.mintId<DocumentId>();
			const writes: StorageWrite[] = [
				{ type: "entry", value: { id: entryId, conversationId: ROOT, kind: "benchmark.mixed" } },
				{ type: "task", value: task(taskId, taskId) },
				{
					type: "submission",
					value: {
						id: submissionId,
						conversationId: ROOT,
						requestId: `benchmark-${submissionId}`,
						type: "write",
						status: "done",
						entry: entryId,
					},
				},
				{
					type: "document.create",
					record: { id: documentId, kind: "benchmark.mixed", key: String(documentId), scope: { kind: "session" } },
					content: { kind: "base", version: 1, value: { entryId, taskId } },
				},
			];
			await storage.commit(writes, context);
			return writes.length;
		},
	},
];
