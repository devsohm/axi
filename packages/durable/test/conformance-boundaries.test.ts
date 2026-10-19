import type { JsonValue } from "@axi/chord";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { expect, it, vi } from "vitest";
import { MemoryStorage } from "../src/storage/memory.ts";
import { createExpectAssertions, createStorageConformance } from "../src/testing/index.ts";
import type { DocumentId, JsonObject, Seq, StoredDocument } from "../src/types.ts";

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
				const at = await commit(...args);
				for (const write of args[0]) {
					if (write.type === "document.create") bases.set(write.record.id, { at, value: write.content.value });
					if (write.type === "document.change" && write.content.kind === "delta")
						for (const op of write.content.ops)
							if (op[0] === "p" && op[1][0] === "items") changes.set(write.id, { at, inserted: op[4] });
				}
				return at;
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
