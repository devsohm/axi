import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@axi/ai";
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@axi/codemode";
import { BACKGROUND_CONTEXT as context, awaitWithContext } from "@axi/objects/context";
import { afterEach, expect, test } from "vitest";
import { Type } from "typebox";
import { CodemodeStoreDoc, createCodemodeExtension } from "../src/codemode/index.ts";
import { CodemodeJournalDoc, CodemodeRunDoc } from "../src/codemode/codemode.ts";
import {
	AssistantEntry,
	createSession,
	defineDoc,
	defineTool,
	LiveDoc,
	ToolResultEntry,
	ToolTask,
} from "../src/index.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { agent, closeSchedulers, open, root } from "./scheduler-support.ts";

const directories: string[] = [];
afterEach(async () => {
	await closeSchedulers();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const Counter = defineDoc({
	kind: "code-recovery-effects",
	version: 1,
	scope: "session",
	initial: () => ({ calls: 0 }),
	checkpointWhen: () => false,
});

test.each(["resume", "version", "deadline", "fingerprint", "call-count"] as const)(
	"a saved code execution handles %s after reopening SQLite",
	async (scenario) => {
		const directory = await mkdtemp(join(tmpdir(), "axi-code-recovery-"));
		directories.push(directory);
		const file = join(directory, "session.sqlite");
		const entered = Promise.withResolvers<void>();
		let paused = true;
		const once = defineTool({
			name: "once",
			description: "Commit one effect",
			parameters: Type.Object({}),
			replay: "safe",
			async execute(_args, api, ctx) {
				await api.commit(async (tx) => {
					(await tx.doc(Counter)).calls++;
				}, ctx);
				return { output: [{ type: "text" as const, text: "7" }] };
			},
		});
		const wait = defineTool({
			name: "wait",
			description: "Wait for interruption",
			parameters: Type.Object({}),
			replay: "safe",
			async execute(_args, _api, ctx) {
				if (paused) {
					entered.resolve();
					await awaitWithContext(new Promise<void>(() => {}), ctx);
				}
				return { output: [{ type: "text" as const, text: "9" }] };
			},
		});
		const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
		const extension = createCodemodeExtension({ sandbox, models: false });
		const tools = [...(extension.tools ?? []), once, wait];
		const options = {
			agent: async () => ({
				...agent,
				tools,
				callable: tools,
				extensions: [extension, { name: "effects", tools: [once, wait] }],
			}),
		};
		const first = await open([ToolTask], { ...options, storage: await openNodeSqliteStorage(file) });
		const conversationId = await root(first.session);
		const id = await first.session.commit(async (tx) => {
			const entry = await tx.appendEntry(AssistantEntry, conversationId, {
				model: [
					fauxAssistantMessage(
						[
							fauxToolCall(
								"codemode",
								{
									code: 'const first=await tools.once({}); const second=await tools.wait({}); store("answer",{first,second}); return {first,second};',
								},
								{ id: "script" },
							),
						],
						{ stopReason: "toolUse" },
					),
				],
			});
			const task = await tx.createTask(
				ToolTask,
				{ kind: "model", assistant: entry.id, callId: "script" },
				{ conversationId, ownership: { kind: "conversation" } },
			);
			(await tx.doc(LiveDoc, conversationId)).tools = [
				{ callId: "script", name: "codemode", taskId: task, status: "pending" },
			];
			return task;
		}, context);
		try {
			first.scheduler.resume();
			await entered.promise;
			expect(await first.session.snapshot(Counter, context)).toEqual({ calls: 1 });
			expect((await first.session.snapshot(CodemodeJournalDoc, id, context))?.entries).toHaveLength(1);
			await first.session.close(context);
			await sandbox.close();
			if (scenario !== "resume") {
				const session = createSession(await openNodeSqliteStorage(file));
				try {
					await session.commit(async (tx) => {
						const run = await tx.doc(CodemodeRunDoc, id);
						if (!run.start) throw new Error("Missing saved run");
						if (scenario === "version") run.start.version = 0;
						if (scenario === "deadline") run.start.deadline = 0;
						if (scenario === "fingerprint") run.start.fingerprint = "previous-runtime";
						if (scenario === "call-count") (await tx.doc(CodemodeJournalDoc, id)).firstIssued = 99;
					}, context);
				} finally {
					await session.close(context);
				}
			}
			paused = false;
			const resumedSandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
			const resumedExtension = createCodemodeExtension({ sandbox: resumedSandbox, models: false });
			const resumedTools = [...(resumedExtension.tools ?? []), once, wait];
			const reopened = await open([ToolTask], {
				storage: await openNodeSqliteStorage(file),
				agent: async () => ({
					...agent,
					tools: resumedTools,
					callable: resumedTools,
					extensions: [resumedExtension, { name: "effects", tools: [once, wait] }],
				}),
			});
			try {
				reopened.scheduler.resume();
				expect((await reopened.scheduler.waitForTask(id, context)).state).toMatchObject({
					status: "terminal",
					outcome: { status: "completed" },
				});
				const page = await reopened.storage.scanEntries({ conversationId }, 100, undefined, context);
				const message = page.items
					.filter(ToolResultEntry.is)
					.flatMap((entry) => entry.model ?? [])
					.find((message) => message.role === "toolResult" && message.toolCallId === "script");
				if (message?.role !== "toolResult") throw new Error("Missing resumed script result");
				const text = message.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
				expect(message.isError).toBe(scenario !== "resume");
				expect(await reopened.session.snapshot(Counter, context)).toEqual({ calls: 1 });
				if (scenario === "resume") {
					expect(await reopened.session.snapshot(CodemodeStoreDoc, conversationId, context)).toEqual({
						values: { answer: { first: "7", second: "9" } },
					});
					expect(text).toContain('{"first":"7","second":"9"}');
				} else {
					expect(text).toContain(
						{
							version: "started under code mode version 0",
							deadline: "deadline passed",
							fingerprint: "sandbox changed",
							"call-count": "different path when resumed",
						}[scenario],
					);
					expect((await reopened.session.snapshot(CodemodeStoreDoc, conversationId, context))?.values).toEqual({});
				}
			} finally {
				await reopened.session.close(context);
				await resumedSandbox.close();
			}
		} finally {
			await first.session.close(context);
			await sandbox.close();
		}
	},
	15000,
);
