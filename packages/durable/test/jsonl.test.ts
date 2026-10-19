import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@axi/chord";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { describe, expect, it } from "vitest";
import { err, FileError, type Result } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { idFromNumber } from "../src/ids.ts";
import { createSession, defineDoc, ROOT_CONVERSATION_ID, type EntryId } from "../src/index.ts";
import { JsonlCorruptionError, JsonlStorage, JsonlStoragePoisonedError } from "../src/storage/jsonl/index.ts";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import type { DocumentId } from "../src/types.ts";

describe("JSONL storage", () => {
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
			await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
			const id = await storage.mintId<EntryId>();
			files.fail = true;
			await expect(
				storage.commit(
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
				expect(await reopened.commit([], context)).toBe(3);
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
