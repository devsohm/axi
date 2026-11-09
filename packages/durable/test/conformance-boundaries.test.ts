import type { JsonValue } from "@axi/objects/json";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, it, vi } from "vitest";
import { seqFromNumber } from "../src/ids.ts";
import { MemoryStorage } from "../src/storage/memory.ts";
import { createExpectAssertions, createStorageConformance } from "../src/testing/index.ts";
import type { DocumentId, JsonObject, Seq, StoredDocument } from "../src/types.ts";

it.each(["never", "twice"] as const)("rejects a storage driver that adopts %s", async (defect) => {
	const storage = new MemoryStorage();
	const commit = storage.commit.bind(storage);
	vi.spyOn(storage, "commit").mockImplementation((writes, adopt, ctx) =>
		commit(
			writes,
			(index, seq) => {
				if (defect === "twice") {
					adopt(index, seq);
					adopt(index, seq);
				}
			},
			ctx,
		),
	);
	try {
		const [check] = createStorageConformance({
			assertions: createExpectAssertions(expect),
			withStorage: (use) => use(storage),
		});
		if (check === undefined) throw new Error("Missing storage checks");
		await expect(check.run()).rejects.toThrow();
	} finally {
		vi.restoreAllMocks();
		await storage.close(context);
	}
});

it("rejects a driver that retains old row fields after a root replacement", async () => {
	const storage = new MemoryStorage();
	const read = storage.document.bind(storage);
	vi.spyOn(storage, "document").mockImplementation(async (...args) => {
		const value = await read(...args);
		if (value === undefined || Number(value.value.revision) < 100 || !Array.isArray(value.value.rows)) return value;
		return {
			...value,
			value: {
				...value.value,
				rows: value.value.rows.map((row, index) => {
					if (row === null || typeof row !== "object" || Array.isArray(row)) throw new Error("Expected a stored row");
					return { ...row, stable: String(index) };
				}),
			},
		};
	});
	try {
		const check = createStorageConformance({
			assertions: createExpectAssertions(expect),
			withStorage: (use) => use(storage),
		}).find((check) => check.name === "streams long document tails across root replacement deltas");
		if (check === undefined) throw new Error("Missing root replacement check");
		await expect(check.run()).rejects.toThrow();
	} finally {
		vi.restoreAllMocks();
		await storage.close(context);
	}
});

it("rejects a driver that accepts nonempty commits after closing", async () => {
	const storage = new MemoryStorage();
	const close = storage.close.bind(storage);
	const commit = storage.commit.bind(storage);
	let closed = false;
	vi.spyOn(storage, "close").mockImplementation(async (ctx) => {
		closed = true;
		await close(ctx);
	});
	vi.spyOn(storage, "commit").mockImplementation(async (batches, receive, ctx) => {
		if (closed && batches.some((batch) => batch.length > 0)) {
			receive(0, seqFromNumber(2));
			return { stored: 1 };
		}
		return commit(batches, receive, ctx);
	});
	try {
		const check = createStorageConformance({
			assertions: createExpectAssertions(expect),
			withStorage: (use) => use(storage),
		}).find((check) => check.name === "rejects every operation after close");
		if (!check) throw new Error("Missing closed-storage check");
		await expect(check.run()).rejects.toThrow();
	} finally {
		vi.restoreAllMocks();
		await storage.close(context);
	}
});

it.each(["sequence after batches", "copy source changed in batch"] as const)(
	"rejects a storage driver that violates %s",
	async (defect) => {
		const storage = new MemoryStorage();
		const commit = storage.commit.bind(storage);
		let afterSeries = false;
		vi.spyOn(storage, "commit").mockImplementation(async (batches, receive, ctx) => {
			const writes =
				defect === "copy source changed in batch"
					? batches.map((batch) =>
							batch.filter(
								(write) =>
									write.type !== "document.change" ||
									!batch.some((other) => other.type === "document.copy" && other.source.id === write.id),
							),
						)
					: batches;
			const result = await commit(writes, (index, seq) => receive(index, afterSeries ? seqFromNumber(1) : seq), ctx);
			if (defect === "sequence after batches" && batches.length > 1) afterSeries = true;
			return result;
		});
		try {
			const check = createStorageConformance({
				assertions: createExpectAssertions(expect),
				withStorage: (use) => use(storage),
			}).find((check) =>
				check.name.startsWith(defect === "sequence after batches" ? "stores ordered batches" : "copies the state left"),
			);
			if (!check) throw new Error("Missing batch conformance check");
			await expect(check.run()).rejects.toThrow();
		} finally {
			await storage.close(context);
		}
	},
);

it.each([
	"checkpoint attempt",
	"structured task result",
	"cursor round trip",
	"descending continuation",
	"document base ownership",
	"document delta ownership",
	"document read ownership",
] as const)("rejects a storage driver that violates %s", async (defect) => {
	const storage = new MemoryStorage();
	try {
		if (defect === "checkpoint attempt" || defect === "structured task result") {
			const read = storage.task.bind(storage);
			vi.spyOn(storage, "task").mockImplementation(async (...args) => {
				const task = await read(...args);
				if (!task) return task;
				const state = task.state;
				if (defect === "checkpoint attempt" && state.status === "running") {
					const checkpoint = state.checkpoint;
					if (checkpoint === null || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return task;
					const { attempt: _attempt, ...rest } = checkpoint;
					return { ...task, state: { ...state, checkpoint: rest } };
				}
				if (
					defect === "structured task result" &&
					state.status === "terminal" &&
					state.outcome.status === "completed"
				) {
					const { memos: _memos, ...record } = task;
					return { ...record, state: { ...state, outcome: { ...state.outcome, result: {} } } };
				}
				return task;
			});
		} else if (defect === "cursor round trip" || defect === "descending continuation") {
			const scan = storage.scanTasks.bind(storage);
			const issued = new WeakSet<object>();
			vi.spyOn(storage, "scanTasks").mockImplementation(async (query, limit, cursor, ctx) => {
				if (
					cursor !== undefined &&
					(defect === "cursor round trip" ? !issued.has(cursor) : query.order === "descending")
				)
					throw new Error("Driver cannot continue cursor");
				const page = await scan(query, limit, cursor, ctx);
				if (page.next) issued.add(page.next);
				return page;
			});
		} else {
			const commit = storage.commit.bind(storage);
			const document = storage.document.bind(storage);
			const bases = new Map<DocumentId, { at: Seq; value: JsonObject }>();
			const changes = new Map<DocumentId, { at: Seq; inserted: readonly JsonValue[] }>();
			const reads = new Map<string, StoredDocument>();
			vi.spyOn(storage, "commit").mockImplementation(async (...args) => {
				const receipts = new Map<number, Seq>();
				const result = await commit(
					args[0],
					(index, seq) => {
						receipts.set(index, seq);
						args[1](index, seq);
					},
					args[2],
				);
				for (const [index, batch] of args[0].entries())
					for (const write of batch) {
						const at = receipts.get(index)!;
						if (write.type === "document.create") bases.set(write.record.id, { at, value: write.content.value });
						if (write.type === "document.change" && write.content.kind === "delta")
							for (const op of write.content.ops)
								if (op[0] === "p" && op[1][0] === "items") changes.set(write.id, { at, inserted: op[4] });
					}
				return result;
			});
			vi.spyOn(storage, "document").mockImplementation(async (...args) => {
				const value = await document(...args);
				if (!value) return value;
				if (defect === "document read ownership") {
					const key = JSON.stringify([args[0], value.version, value.value]);
					const previous = reads.get(key);
					if (previous) return previous;
					reads.set(key, value);
					return value;
				}
				const base = bases.get(args[0]);
				if (defect === "document base ownership" && args[1] === base?.at) return { ...value, value: base.value };
				const change = changes.get(args[0]);
				if (defect === "document delta ownership" && args[1] === change?.at && change.inserted.length > 1) {
					const items = value.value.items;
					if (!Array.isArray(items)) throw new Error("Expected stored items");
					return { ...value, value: { ...value.value, items: [...items, ...change.inserted.slice(1)] } };
				}
				return value;
			});
		}
		const prefix = defect.startsWith("document ")
			? "reconstructs rewindable"
			: defect === "checkpoint attempt" || defect === "structured task result"
				? "replaces complete task records"
				: "scans tables in either";
		const test = createStorageConformance({
			assertions: createExpectAssertions(expect),
			withStorage: (use) => use(storage),
		}).find((test) => test.name.startsWith(prefix));
		if (!test) throw new Error("Missing storage check");
		await expect(test.run()).rejects.toThrow();
	} finally {
		await storage.close(context);
	}
});
