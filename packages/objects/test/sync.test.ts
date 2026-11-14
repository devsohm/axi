import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../../durable/src/env/node.ts";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import { sqliteBackend } from "../src/store/backend.ts";
import { createDocument } from "../src/store/engine.ts";
import { openStore, ObjectsStore, type Store } from "../src/store/store.ts";
import {
	decodeBatch,
	decodeLogLine,
	encodeBatch,
	FileSyncStateStore,
	FileSystemSyncRemote,
	FlushScheduler,
	foldSession,
	pullSession,
	uploadSession,
	type SessionSyncStore,
} from "../src/sync/index.ts";

const directories: string[] = [],
	stores: Store[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close(context);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
	vi.useRealTimers();
});
const backend = async () => sqliteBackend(await openNodeSqliteDatabase(":memory:"));
async function local(): Promise<ObjectsStore> {
	const store = await openStore(await backend(), context, { outbox: true });
	stores.push(store);
	if (!(store instanceof ObjectsStore)) throw new Error("Expected the SQLite fixture store");
	return store;
}
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "axi-sync-"));
	directories.push(directory);
	const files = new NodeExecutionEnv({ cwd: directory });
	return {
		remote: new FileSystemSyncRemote(files, join(directory, "remote")),
		state: new FileSyncStateStore(files, join(directory, "state")),
	};
}
async function add(store: ObjectsStore, key: string) {
	const value = { key };
	await store.commit(
		[
			createDocument(
				{ namespace: "notes", owner: "sync", kind: "item", key },
				{ version: 1, fingerprint: "v1", value },
				JSON.stringify(value),
			),
		],
		{ admit: () => true, adopt() {} },
		context,
	);
}
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const value of source) result.push(value);
	return result;
}

it("round-trips streamed log records and rejects malformed envelope fields", async () => {
	const commits = [
		{ seq: 7, nextId: 19, writes: [] },
		{ seq: 8, nextId: 20, writes: [] },
	];
	expect(await collect(decodeBatch(encodeBatch(commits)))).toEqual(commits);
	for (const text of [
		"null",
		'{"v":3}',
		'{"v":2,"seq":0}',
		'{"v":2,"seq":1,"nextId":null}',
		'{"v":2,"seq":1,"nextId":2,"writes":{}}',
	]) {
		expect(() => decodeLogLine(text, 4)).toThrow("Log line 4");
	}
});

it("captures session metadata before asynchronous filesystem work starts", async () => {
	const { remote } = await fixture();
	const metadata = { title: "before" };
	const pending = remote.putMeta("shared", metadata, context);
	metadata.title = "after";
	await pending;
	expect(await remote.getMeta("shared", context)).toEqual({ title: "before" });
});

it("rejects metadata serialization failures through its promise without publishing a session", async () => {
	const { remote } = await fixture();
	const failure = new Error("metadata unavailable");
	await expect(
		remote.putMeta(
			"shared",
			{
				toJSON() {
					throw failure;
				},
			},
			context,
		),
	).rejects.toBe(failure);
	expect((await remote.sessions(undefined, context)).sessions).toEqual([]);
});

it("recovers a lost upload reply, restores a copy and folds its history through real files", async () => {
	const { remote, state } = await fixture(),
		source = await local();
	await add(source, "first");
	const put = remote.putBatch.bind(remote);
	let lost = true;
	remote.putBatch = async (...args) => {
		const result = await put(...args);
		if (lost) {
			lost = false;
			throw new Error("reply lost");
		}
		return result;
	};
	const upload = () => uploadSession({ sessionId: "shared", device: "writer", source, store: remote, state, context });
	await expect(upload()).rejects.toThrow("reply lost");
	expect(await state.get("shared", context)).toBeUndefined();
	expect(await upload()).toEqual({ type: "idle" });
	expect(source.outbox?.floor).toBe(source.lastSeq);
	await add(source, "second");
	expect(await upload()).toEqual({ type: "uploaded", head: source.lastSeq });
	expect(await foldSession({ sessionId: "shared", store: remote, scratch: await backend(), context })).toBe(
		source.lastSeq,
	);
	const restored = await pullSession({
		sessionId: "shared",
		store: remote,
		local: { kind: "empty", backend: await backend() },
		state: {
			async get() {
				return undefined;
			},
			async set() {},
		},
		context,
	});
	stores.push(restored.store);
	expect(await collect(restored.store.export(context))).toEqual(await collect(source.export(context)));
});

it("resumes an interrupted pull without treating the applied prefix as local work", async () => {
	const { remote, state } = await fixture(),
		source = await local(),
		copy = await local();
	const writer = {
		async get() {
			return undefined;
		},
		async set() {},
	};
	await add(source, "one");
	await uploadSession({ sessionId: "shared", device: "writer", source, store: remote, state: writer, context });
	await add(source, "two");
	await uploadSession({ sessionId: "shared", device: "writer", source, store: remote, state: writer, context });
	const get = remote.getBatch.bind(remote);
	let interrupt = true;
	remote.getBatch = async (id, after, ctx) => {
		if (after > 0 && interrupt) {
			interrupt = false;
			throw new Error("offline");
		}
		return get(id, after, ctx);
	};
	const pull = () =>
		pullSession({ sessionId: "shared", store: remote, local: { kind: "store", store: copy }, state, context });
	await expect(pull()).rejects.toThrow("offline");
	expect(copy.lastSeq).toBeGreaterThan(0);
	expect(copy.lastSeq).toBeLessThan(source.lastSeq);
	await pull();
	expect(await collect(copy.export(context))).toEqual(await collect(source.export(context)));
});

it("forwards the writer epoch and leaves progress untouched on refusal", async () => {
	const { remote, state } = await fixture(),
		source = await local();
	await add(source, "unpublished");
	const epochs: (number | undefined)[] = [];
	remote.putBatch = async (...args: Parameters<SessionSyncStore["putBatch"]>) => {
		epochs.push(args[6]?.epoch);
		return { type: "stale_epoch", epoch: 9 };
	};
	expect(
		await uploadSession({ sessionId: "shared", device: "writer", epoch: 8, source, store: remote, state, context }),
	).toEqual({ type: "stale_epoch", at: 0, epoch: 9 });
	expect(epochs).toEqual([8]);
	expect(await state.get("shared", context)).toBeUndefined();
	expect(source.outbox?.floor).toBe(0);
});

it("retries failed uploads without another commit and performs the closing flush", async () => {
	vi.useFakeTimers();
	const errors: unknown[] = [];
	let attempts = 0;
	const scheduler = new FlushScheduler({
		now: () => Date.now(),
		setTimer(callback, delay) {
			const timer = setTimeout(callback, delay);
			return () => clearTimeout(timer);
		},
		async flush() {
			if (++attempts === 1) throw new Error("offline");
		},
		onError(error) {
			errors.push(error);
		},
	});
	scheduler.notify(true);
	await vi.advanceTimersByTimeAsync(200);
	expect(attempts).toBe(1);
	await vi.advanceTimersByTimeAsync(1000);
	expect(attempts).toBe(2);
	expect(errors).toHaveLength(1);
	await scheduler.close();
	expect(attempts).toBe(3);
	scheduler.notify(true);
	await vi.advanceTimersByTimeAsync(10_000);
	expect(attempts).toBe(3);
});
