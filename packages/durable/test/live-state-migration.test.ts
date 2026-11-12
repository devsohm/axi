import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import { createSession, defineDoc, LiveDoc, type JsonObject } from "../src/index.ts";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";

for (const backend of ["sqlite", "jsonl"] as const)
	test.each<{ name: string; version: number; value: JsonObject; expected: JsonObject }>([
		{
			name: "version 1 compaction names and missing turn count",
			version: 1,
			value: {
				run: { taskId: 7, inputs: [8] },
				compactions: [{ taskId: 9, reason: "manual", blocking: true, attempt: 2 }],
				compactionFailure: { taskId: 10, reason: "threshold", error: "Summary failed" },
			},
			expected: {
				run: { taskId: 7, inputs: [8], turns: 0 },
				compactions: [{ taskId: 9, trigger: "manual", blocking: true, attempt: 2 }],
				compactionFailure: { taskId: 10, trigger: "threshold", error: "Summary failed" },
			},
		},
		{
			name: "version 2 turn count and current compaction names",
			version: 2,
			value: {
				run: { taskId: 7, inputs: [8], turns: 4 },
				compactions: [{ taskId: 9, trigger: "overflow", blocking: false, attempt: 1 }],
			},
			expected: {
				run: { taskId: 7, inputs: [8], turns: 4 },
				compactions: [{ taskId: 9, trigger: "overflow", blocking: false, attempt: 1 }],
			},
		},
		{ name: "an idle version 1 document", version: 1, value: {}, expected: {} },
	])(
		`${backend} live state migrates $name without writing until a transaction uses it`,
		async ({ version, value, expected }) => {
			const directory = await mkdtemp(join(tmpdir(), "axi-live-upgrade-"));
			const open = () =>
				backend === "sqlite"
					? openNodeSqliteStorage(join(directory, "session.sqlite"))
					: openNodeJsonlStorage(join(directory, "session"), context);
			let storage = await open();
			let session = createSession(storage);
			const Legacy = defineDoc<JsonObject>({
				kind: LiveDoc.definition.kind,
				version,
				scope: "conversation",
				history: "latest",
				fork: "initial",
				initial: () => structuredClone(value),
				checkpointWhen: () => false,
			});
			try {
				const conversation = await session.commit(
					(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
					context,
				);
				await session.commit(async (tx) => {
					await tx.doc(Legacy, conversation.id);
				}, context);
				const record = await storage.findDocument(
					{
						kind: LiveDoc.definition.kind,
						scope: { kind: "conversation", conversationId: conversation.id },
					},
					"current",
					context,
				);
				if (!record) throw new Error("The legacy live document was not stored");
				expect(await session.snapshot(LiveDoc, conversation.id, context)).toEqual(expected);
				expect(await storage.document(record.id, "current", context)).toMatchObject({ version, value });
				await session.commit(async (tx) => {
					await tx.doc(LiveDoc, conversation.id);
				}, context);
				expect(await storage.document(record.id, "current", context)).toMatchObject({
					version: LiveDoc.definition.version,
					value: expected,
					deltasSinceBase: 0,
				});
				await session.close(context);
				storage = await open();
				session = createSession(storage);
				expect(await session.snapshot(LiveDoc, conversation.id, context)).toEqual(expected);
			} finally {
				await session.close(context);
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
