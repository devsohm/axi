import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../src/env/node.ts";
import type { BinaryReader } from "../src/env/index.ts";
import { MemoryStorage } from "../src/storage/memory.ts";
import {
	createEnvConformance,
	createExpectAssertions,
	createStorageConformance,
	registerEnvConformance,
	registerStorageConformance,
	seedStorageBenchmark,
	STORAGE_READ_BENCHMARKS,
} from "../src/testing/index.ts";

it("rejects a reader that returns a byte-order mark for an empty range", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "axi-reader-check-"));
	const env = new NodeExecutionEnv({ cwd });
	const readers: BinaryReader[] = [];
	const open = env.openBinaryReader.bind(env);
	vi.spyOn(env, "openBinaryReader").mockImplementation(async (...args) => {
		const result = await open(...args);
		if (result.ok) {
			const reader = result.value;
			readers.push(reader);
			const read = reader.read.bind(reader);
			vi.spyOn(reader, "read").mockImplementation((offset, length, ctx) =>
				offset >= 11 || length === 0
					? Promise.resolve({ ok: true, value: Uint8Array.of(239, 187, 191) })
					: read(offset, length, ctx),
			);
		}
		return result;
	});
	try {
		const test = createEnvConformance({
			assertions: createExpectAssertions(expect),
			withEnv: (use) => use(env),
		}).find((test) => test.name === "binary reader reads byte ranges of the opened file");
		if (!test) throw new Error("Missing byte-range check");
		await expect(test.run()).rejects.toThrow();
	} finally {
		for (const reader of readers) await reader.close(context);
		vi.restoreAllMocks();
		await env.cleanup(context);
		await rm(cwd, { recursive: true, force: true });
	}
});

it("starts the watcher delivery deadline after a slow write completes", async () => {
	const clock = vi.spyOn(Date, "now").mockReturnValue(0);
	const env = new NodeExecutionEnv({ cwd: tmpdir() });
	let notify = () => {};
	let deliveries = 0;
	vi.spyOn(env, "watch").mockImplementation(async (_targets, onChange) => {
		notify = () => {
			deliveries++;
			onChange({ paths: [join(tmpdir(), "a/b/c/AGENTS.md")] });
		};
		return { ok: true, value: { mode: "native", close: async () => {} } };
	});
	vi.spyOn(env, "writeFile").mockImplementation(async () => {
		clock.mockReturnValue(4000);
		setTimeout(notify, 0);
		return { ok: true, value: undefined };
	});
	try {
		const test = createEnvConformance({
			assertions: createExpectAssertions(expect),
			withEnv: (use) => use(env),
		}).find((test) => test.name === "watch reports a missing target whose ancestors are created");
		if (!test) throw new Error("Missing watcher case");
		await test.run();
		expect(deliveries).toBe(1);
	} finally {
		vi.restoreAllMocks();
	}
});

it.each([
	"document kind",
	"task kind",
	"checkpoint fields",
	"submission scope",
	"copied nested state",
	"task paging",
	"owner paging",
	"unfiltered document scope",
	"fork paging",
] as const)("rejects a storage driver that loses %s", async (defect) => {
	const storage = new MemoryStorage();
	try {
		if (defect === "fork paging") {
			const scan = storage.scanEntries.bind(storage);
			vi.spyOn(storage, "scanEntries").mockImplementation((query, max, cursor, ctx) =>
				scan(query, query.order !== "ascending" && max === 2 && cursor === undefined ? 100 : max, cursor, ctx),
			);
		} else if (defect === "document kind" || defect === "unfiltered document scope") {
			const scan = storage.scanDocuments.bind(storage);
			vi.spyOn(storage, "scanDocuments").mockImplementation((query, ...args) =>
				defect === "document kind"
					? scan({ ...query, kind: undefined }, ...args)
					: query.kind === undefined
						? Promise.resolve({ items: [] })
						: scan(query, ...args),
			);
		} else if (defect === "task kind" || defect === "checkpoint fields") {
			const read = storage.task.bind(storage);
			vi.spyOn(storage, "task").mockImplementation(async (...args) => {
				const value = await read(...args);
				if (defect === "task kind") return value && { ...value, kind: "wrong" };
				if (
					value?.state.status !== "pending" ||
					value.state.checkpoint === null ||
					typeof value.state.checkpoint !== "object" ||
					Array.isArray(value.state.checkpoint)
				)
					return value;
				return { ...value, state: { ...value.state, checkpoint: { ...value.state.checkpoint, phase: "wrong" } } };
			});
		} else if (defect === "submission scope") {
			const scan = storage.scanSubmissions.bind(storage);
			vi.spyOn(storage, "scanSubmissions").mockImplementation((query, ...args) =>
				scan(query.status === undefined ? { ...query, conversationId: undefined } : query, ...args),
			);
		} else if (defect === "copied nested state") {
			const read = storage.document.bind(storage);
			vi.spyOn(storage, "document").mockImplementation(async (...args) => {
				const value = await read(...args);
				if (value === undefined) return value;
				const { rows: _rows, ...content } = value.value;
				return { ...value, value: content };
			});
		} else if (defect === "task paging") {
			const scan = storage.scanTasks.bind(storage);
			vi.spyOn(storage, "scanTasks").mockImplementation((query, max, ...args) =>
				scan(query, query.status === "pending" ? 10 : max, ...args),
			);
		} else {
			const scan = storage.scanConversations.bind(storage);
			vi.spyOn(storage, "scanConversations").mockImplementation((query, max, ...args) =>
				scan(query, query.ownerConversationId === undefined ? max : 10, ...args),
			);
		}
		const cases = createStorageConformance({
			assertions: createExpectAssertions(expect),
			withStorage: (use) => use(storage),
		});
		const name = {
			"document kind": "indexes logical addresses",
			"task kind": "keeps indexed string identities",
			"checkpoint fields": "detaches retained writes",
			"submission scope": "indexes request IDs",
			"copied nested state": "copies stored document bases",
			"task paging": "replaces complete task records",
			"owner paging": "filters and pages conversations",
			"unfiltered document scope": "indexes logical addresses",
			"fork paging": "scans deep fork history",
		}[defect];
		const selected = cases.find((test) => test.name.startsWith(name));
		if (!selected) throw new Error(`Missing driver check: ${name}`);
		await expect(selected.run()).rejects.toThrow();
	} finally {
		await storage.close(context);
	}
});

registerStorageConformance({ describe, expect, it }, "storage driver checks", async (use) => {
	for (const driver of ["memory", "jsonl", "sqlite"] as const) {
		const directory = await mkdtemp(join(tmpdir(), `axi-${driver}-`));
		const storage =
			driver === "memory"
				? new MemoryStorage()
				: driver === "jsonl"
					? await openNodeJsonlStorage(directory, context)
					: await openNodeSqliteStorage(join(directory, "session.sqlite"));
		try {
			await use(storage);
		} finally {
			await storage.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	}
});
registerEnvConformance({ describe, expect, it }, "environment driver checks", async (use) => {
	const cwd = await mkdtemp(join(tmpdir(), "axi-driver-"));
	const env = new NodeExecutionEnv({ cwd });
	try {
		await use(env);
	} finally {
		await env.cleanup(context);
		await rm(cwd, { recursive: true, force: true });
	}
});
it("seeds a storage dataset that every read benchmark can consume", async () => {
	const storage = new MemoryStorage();
	try {
		const data = await seedStorageBenchmark(storage, {
			name: "small",
			entryCount: 100,
			taskCount: 121,
			documentCount: 5,
		});
		const values = [];
		for (const benchmark of STORAGE_READ_BENCHMARKS) values.push(await benchmark.run(storage, data));
		expect(values).toEqual([2, 100, 3, 227, 0, 16, 128, 1024, 128, 256, 100, 2]);
	} finally {
		await storage.close(context);
	}
});
