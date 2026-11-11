import { commitWrites } from "../src/testing/commit-writes.ts";
import { mkdtemp, rm, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import type { Context } from "@axi/objects/context";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { describe, expect, it } from "vitest";
import { err, FileError, type Result } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { idFromNumber } from "../src/ids.ts";
import { createSession, defineDoc, defineTask, ROOT_CONVERSATION_ID, type EntryId } from "../src/index.ts";
import { JsonlCorruptionError, JsonlStorage, JsonlStoragePoisonedError } from "../src/storage/jsonl/index.ts";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import type { DocumentId } from "../src/types.ts";

describe("JSONL storage", () => {
	it("opens a viewer without repairing files and keeps its initial committed snapshot", async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-jsonl-viewer-"));
		const writer = createSession(await openNodeJsonlStorage(directory, context));
		let viewer: JsonlStorage | undefined;
		const bytes = async () =>
			Object.fromEntries(
				await Promise.all(
					(await readdir(directory))
						.sort()
						.map(async (name) => [name, (await readFile(join(directory, name))).toString("base64")]),
				),
			);
		try {
			const conversation = await writer.commit(
				(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
				context,
			);
			const entry = await writer.commit(
				(tx) => tx.appendEntry(conversation.id, { kind: "first", data: "saved" }),
				context,
			);
			await writeFile(join(directory, "main.jsonl"), '{"torn":', { flag: "a" });
			await writeFile(join(directory, "task-99.jsonl.reclaim"), "leftover");
			const before = await bytes();
			viewer = await openNodeJsonlStorage(directory, context, { readOnly: true });
			expect((await viewer.entry(entry.id, context))?.entry.data).toBe("saved");
			await expect(viewer.commit([], () => {}, context)).rejects.toMatchObject({ name: "JsonlStorageReadOnlyError" });
			expect(await bytes()).toEqual(before);
			const main = await readFile(join(directory, "main.jsonl"));
			await writeFile(join(directory, "main.jsonl"), main.subarray(0, main.length - 8));
			const later = await writer.commit(
				(tx) => tx.appendEntry(conversation.id, { kind: "later", data: "new" }),
				context,
			);
			expect(await viewer.entry(later.id, context)).toBeUndefined();
			await viewer.close(context);
			viewer = await openNodeJsonlStorage(directory, context);
			expect((await viewer.entry(later.id, context))?.entry.data).toBe("new");
			await expect(stat(join(directory, "task-99.jsonl.reclaim"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await viewer?.close(context);
			await writer.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("a read-only open does not create a missing directory", async () => {
		const parent = await mkdtemp(join(tmpdir(), "axi-jsonl-missing-")),
			directory = join(parent, "missing");
		try {
			await expect(openNodeJsonlStorage(directory, context, { readOnly: true })).rejects.toThrow(/directory listing/);
			await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});
	it("a viewer retries when a writer reclaims a sidecar, but refuses stable missing data", async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-jsonl-race-"));
		const storage = await openNodeJsonlStorage(directory, context),
			session = createSession(storage);
		const task = defineTask<null, { phase: "hold" }, null>({
			name: "viewer-task",
			version: 1,
			initial: () => ({ phase: "hold" }),
			phases: { hold: async () => {} },
			abort: async () => {},
		});
		class Files extends NodeExecutionEnv {
			mainReads = 0;
			onRead: (() => Promise<void>) | undefined;
			override async readBinaryFile(path: string, ctx: Context) {
				if (basename(path) === "main.jsonl") this.mainReads++;
				if (basename(path).startsWith("task-") && this.onRead) {
					const action = this.onRead;
					this.onRead = undefined;
					await action();
				}
				return super.readBinaryFile(path, ctx);
			}
		}
		let viewer: JsonlStorage | undefined;
		try {
			const conversation = await session.commit(
				(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
				context,
			);
			const ids = await session.commit(
				(tx) =>
					Promise.all(
						[1, 2].map(() =>
							tx.createTask(task, null, { conversationId: conversation.id, ownership: { kind: "conversation" } }),
						),
					),
				context,
			);
			const pending = await storage.task(ids[0], context);
			if (!pending) throw new Error("Missing pending task");
			const { state: _state, memos: _memos, ...fields } = pending;
			const terminal = {
				...fields,
				state: { status: "terminal" as const, outcome: { status: "completed" as const, result: null } },
			};
			const files = new Files({ cwd: directory });
			files.onRead = () => commitWrites(storage, [{ type: "task", value: terminal }], context).then(() => {});
			viewer = await JsonlStorage.open(directory, files, context, { readOnly: true });
			expect(await viewer.task(ids[0], context)).toEqual(terminal);
			expect(files.mainReads).toBe(2);
			await viewer.close(context);
			await writeFile(join(directory, `task-${ids[1]}.jsonl`), "");
			const stable = new Files({ cwd: directory });
			await expect(JsonlStorage.open(directory, stable, context, { readOnly: true })).rejects.toBeInstanceOf(
				JsonlCorruptionError,
			);
			expect(stable.mainReads).toBe(1);
		} finally {
			await viewer?.close(context);
			await session.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("recovers the newest confirmed document base independently of marker order", async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-jsonl-"));
		const id = idFromNumber<DocumentId>(2);
		const encode = (records: readonly unknown[]) => records.map((record) => `${JSON.stringify(record)}\n`).join("");
		try {
			await writeFile(
				join(directory, "main.jsonl"),
				encode([
					{
						format: 1,
						type: "commit",
						seq: 1,
						writes: [
							{ type: "document.create", record: { id, kind: "settings", scope: { kind: "session" } }, ordinal: 0 },
						],
					},
					{
						format: 1,
						type: "commit",
						seq: 2,
						writes: [
							{ type: "document.change", id, ordinal: 2 },
							{ type: "document.change", id, ordinal: 1 },
						],
					},
				]),
			);
			await writeFile(
				join(directory, "doc-2.jsonl"),
				encode(
					[
						{ seq: 1, ordinal: 0, count: 0 },
						{ seq: 2, ordinal: 1, count: 1 },
						{ seq: 2, ordinal: 2, count: 2 },
					].map(({ seq, ordinal, count }) => ({
						format: 1,
						type: "record",
						seq,
						ordinal,
						payload: { type: "document", id, content: { kind: "base", version: 1, value: { count } } },
					})),
				),
			);
			const storage = await openNodeJsonlStorage(directory, context);
			try {
				expect((await storage.document(id, "current", context))?.value).toEqual({ count: 2 });
			} finally {
				await storage.close(context);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("restores Session document revisions and forks after a checkpoint and reopening", async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-jsonl-"));
		const State = defineDoc({
			checkpointWhen: () => false,
			kind: "settings",
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			version: 1,
			initial: () => ({ text: "", count: 0 }),
		});
		let session = createSession(await openNodeJsonlStorage(directory, context));
		try {
			const conversation = await session.commit(
				(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
				context,
			);
			const entry = await session.commit(async (tx) => {
				const state = await tx.doc(State, conversation.id);
				state.text = "こんにちは";
				state.count = 1;
				return tx.appendEntry(conversation.id, { kind: "saved" });
			}, context);
			await session.commit(async (tx) => {
				(await tx.doc(State, conversation.id)).count = 2;
			}, context);
			await session.close(context);
			session = createSession(await openNodeJsonlStorage(directory, context));
			const fork = await session.commit(
				(tx) => tx.forkConversation(conversation.id, entry.id, { ownership: { kind: "ownerless" } }),
				context,
			);
			expect(await session.snapshot(State, conversation.id, context)).toEqual({ text: "こんにちは", count: 2 });
			expect(await session.snapshot(State, fork.id, context)).toEqual({ text: "こんにちは", count: 1 });
			await session.close(context);
			session = createSession(await openNodeJsonlStorage(directory, context));
			expect(await session.snapshot(State, fork.id, context)).toEqual({ text: "こんにちは", count: 1 });
		} finally {
			await session.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("requires reopening after an acknowledged marker has an uncertain outcome", async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-jsonl-"));
		class Files extends NodeExecutionEnv {
			fail = false;
			override async appendFile(
				path: string,
				content: string | Uint8Array,
				ctx: Context,
			): Promise<Result<void, FileError>> {
				const result = await super.appendFile(path, content, ctx);
				return result.ok && this.fail && path.endsWith("main.jsonl")
					? err(new FileError("unknown", "lost acknowledgement", path))
					: result;
			}
		}
		const files = new Files({ cwd: directory });
		const storage = await JsonlStorage.open(directory, files, context);
		try {
			await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
			const id = await storage.mintId<EntryId>();
			files.fail = true;
			await expect(
				commitWrites(
					storage,
					[{ type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "saved" } }],
					context,
				),
			).rejects.toBeInstanceOf(JsonlStoragePoisonedError);
			await expect(storage.entry(id, context)).rejects.toBeInstanceOf(JsonlStoragePoisonedError);
			await storage.close(context);
			const reopened = await openNodeJsonlStorage(directory, context);
			try {
				expect((await reopened.entry(id, context))?.entry).toEqual({
					id,
					conversationId: ROOT_CONVERSATION_ID,
					kind: "saved",
				});
				expect(await commitWrites(reopened, [], context)).toBe(3);
			} finally {
				await reopened.close(context);
			}
		} finally {
			await storage.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("rejects invalid UTF-8 on a complete line rather than repairing committed input", async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-jsonl-"));
		try {
			await writeFile(join(directory, "main.jsonl"), new Uint8Array([0xc3, 0x28, 10]));
			await expect(openNodeJsonlStorage(directory, context)).rejects.toBeInstanceOf(JsonlCorruptionError);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
