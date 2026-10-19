import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@axi/ai";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@axi/chord/context";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { resolveSettings } from "../src/harness/agent.ts";
import { readContextFrom } from "../src/harness/context.ts";
import { planSystemEntries, renderSections } from "../src/harness/prompt.ts";
import type { PromptInput, PromptSection, ToolRegistration } from "../src/harness/types.ts";
import { recordUsage } from "../src/harness/usage.ts";
import {
	AgentDoc,
	configure,
	createRegistry,
	createSession,
	DEFAULT_COMPACTION_POLICY,
	DEFAULT_PROGRESS_POLICY,
	DEFAULT_RESTART_LIMIT,
	DEFAULT_RETRY_POLICY,
	defineExtension,
	defineTask,
	defineTool,
	Harness,
	MemoryStorage,
	ProviderDoc,
	UsageDoc,
} from "../src/index.ts";
import { SessionImpl } from "../src/session/session.ts";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";

describe("conversation state", () => {
	it("preserves custom registry sections before conversation instructions", async () => {
		const base = createRegistry().snapshot();
		const extension = defineExtension({
			name: "custom",
			sections: [{ key: "instructions", render: () => "Extension" }],
		});
		const registry = {
			snapshot: () => ({
				installed: () => [extension],
				extension: (name: string) => (name === extension.name ? extension : undefined),
				tasks: () => base.tasks(),
				task: (name: string) => base.task(name),
				tools: () => [],
				sections: () => extension.sections!.map((section) => ({ extension, section })),
			}),
			subscribe: () => () => {},
		};
		const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
		try {
			const conversation = await harness.root(context, { agent: { instructions: "Conversation" } });
			const agent = await conversation.agent(context);
			const input: PromptInput = {
				conversationId: conversation.id,
				agent,
				env: undefined,
				shown: {},
				read: harness,
			};
			expect(
				await Promise.all(
					agent.sections.map(async (section) => ({
						key: section.key,
						text: await section.render(input, context),
					})),
				),
			).toEqual([
				{ key: "instructions", text: "Extension" },
				{ key: "instructions", text: "Conversation" },
			]);
		} finally {
			await harness.close(context);
		}
	});
	it("returns whether a registry listener was removed", () => {
		const registry = createRegistry();
		const remove = registry.subscribe(() => {});
		expect(remove()).toBe(true);
		expect(remove()).toBe(false);
	});
	it("serializes system sections before their timestamp", () => {
		const entries = planSystemEntries(
			{ head: undefined, entries: [], contributions: [], messages: [] },
			new Map([["instructions", "Go"]]),
			[],
			9,
		);
		expect(JSON.stringify(entries)).toBe(
			'[{"model":[{"role":"system","content":"","sections":{"instructions":"Go"},"timestamp":9}]}]',
		);
	});
	it("captures each agent configuration field before applying its change", async () => {
		const session = createSession(new MemoryStorage());
		const reads: string[] = [];
		try {
			const root = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
			await session.commit(
				(tx) =>
					configure(tx, root.id, {
						get thinkingLevel(): "low" | "high" {
							reads.push("thinkingLevel");
							return reads.length === 1 ? "low" : "high";
						},
						get extensions() {
							reads.push("extensions");
							return [];
						},
						get tools() {
							reads.push("tools");
							return [];
						},
						get modelTools() {
							reads.push("modelTools");
							return { remove: [], add: [] };
						},
						get instructions() {
							reads.push("instructions");
							return "Keep the current task.";
						},
						get cwd() {
							reads.push("cwd");
							return "/work";
						},
					}),
				context,
			);
			expect(await session.snapshot(AgentDoc, root.id, context)).toEqual({
				thinkingLevel: "low",
				extensions: [],
				tools: [],
				modelTools: { remove: [], add: [] },
				instructions: "Keep the current task.",
				cwd: "/work",
			});
			expect(reads).toEqual(["thinkingLevel", "extensions", "tools", "modelTools", "instructions", "cwd"]);
		} finally {
			await session.close(context);
		}
	});
	it("resolves settings getters in order and reads the restart limit last", () => {
		const reads: string[] = [];
		let limit = 1;
		const settings = resolveSettings({
			get restartLimit() {
				reads.push("restartLimit");
				return limit;
			},
			get extensions() {
				reads.push("extensions");
				return [];
			},
			get stream() {
				reads.push("stream");
				limit = 9;
				return {};
			},
		});
		expect(settings.restartLimit).toBe(9);
		expect(settings.extensions).toEqual([]);
		expect(reads).toEqual(["extensions", "stream", "restartLimit"]);
	});
	it("inspects sleeping tasks without resolving their definitions", async () => {
		const asleep = Promise.withResolvers<void>();
		const task = defineTask<null, { phase: "run" }, null>({
			name: "sleeper",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				async run(_record, runtime, ctx) {
					await runtime.sleepUntil(100, { phase: "run" }, ctx);
					asleep.resolve();
				},
			},
			async abort() {},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "sleep", tasks: [task] }));
		let rejectLookup = false;
		const reader = {
			subscribe: (listener: () => void) => registry.subscribe(listener),
			snapshot() {
				const snapshot = registry.snapshot();
				return {
					installed: () => snapshot.installed(),
					extension: (name: string) => snapshot.extension(name),
					tools: () => snapshot.tools(),
					sections: () => snapshot.sections(),
					tasks: () => snapshot.tasks(),
					task(name: string) {
						if (rejectLookup && name === "sleeper") throw new Error("lookup unavailable");
						return snapshot.task(name);
					},
				};
			},
		};
		const harness = await Harness.open(
			new MemoryStorage(),
			{ registry: reader, models: createModels(), now: () => 0 },
			context,
		);
		try {
			const conversation = await harness.root(context);
			await conversation.commit((tx) => tx.createTask(task, null, { ownership: { kind: "conversation" } }), context);
			harness.resume();
			await asleep.promise;
			await expect.poll(async () => (await harness.inspect(context)).tasks[0]?.state.kind).toBe("sleeping");
			rejectLookup = true;
			expect((await harness.inspect(context)).tasks[0]?.state).toEqual({ kind: "sleeping", until: 100 });
		} finally {
			await harness.close(context);
		}
	});
	it("retains the report callback supplied when the harness opens", async () => {
		const registry = createRegistry();
		registry.install(
			defineExtension({
				name: "broken",
				sections: [{ key: "summary", render: () => "text" }],
				wraps: [
					{
						section: "summary",
						wrap() {
							throw new Error("wrapper failed");
						},
					},
				],
			}),
		);
		const initial: unknown[] = [],
			replacement: unknown[] = [];
		const options = {
			registry,
			models: createModels(),
			onReport: (error: unknown) => {
				initial.push(error);
			},
		};
		const harness = await Harness.open(new MemoryStorage(), options, context);
		try {
			options.onReport = (error) => {
				replacement.push(error);
			};
			await (await harness.root(context)).agent(context);
			expect(initial).toEqual([expect.objectContaining({ message: "wrapper failed" })]);
			expect(replacement).toEqual([]);
		} finally {
			await harness.close(context);
		}
	});
	it("preserves wrapper method receivers while resolving tools and sections", async () => {
		const registry = createRegistry();
		registry.install(
			defineExtension({
				name: "wrapped",
				tools: [
					defineTool({
						name: "echo",
						description: "plain",
						parameters: Type.Object({}),
						execute: async () => ({ output: [] }),
					}),
				],
				sections: [{ key: "details", render: () => "plain" }],
				wraps: [
					{
						tool: "echo",
						wrap(tool: ToolRegistration) {
							return { ...tool, description: `wrapped ${this.tool}` };
						},
					},
					{
						section: "details",
						wrap(section: PromptSection) {
							return { ...section, key: this.section };
						},
					},
				],
			}),
		);
		const reports: unknown[] = [];
		const harness = await Harness.open(
			new MemoryStorage(),
			{ registry, models: createModels(), onReport: (error) => reports.push(error) },
			context,
		);
		try {
			const agent = await (await harness.root(context)).agent(context);
			expect(agent.tools.map((tool) => tool.description)).toEqual(["wrapped echo"]);
			expect(agent.sections.map((section) => section.key)).toEqual(["details"]);
			expect(reports).toEqual([]);
		} finally {
			await harness.close(context);
		}
	});
	it("closes storage after a shutdown checkpoint fails", async () => {
		const failure = new Error("checkpoint unavailable");
		class Storage extends MemoryStorage {
			failWrites = false;
			closeCalls = 0;
			override async commit(...args: Parameters<MemoryStorage["commit"]>) {
				if (this.failWrites) throw failure;
				return super.commit(...args);
			}
			override async close(...args: Parameters<MemoryStorage["close"]>) {
				this.closeCalls++;
				return super.close(...args);
			}
		}
		const entered = Promise.withResolvers<void>();
		const task = defineTask<null, { phase: "run" }, null>({
			name: "waiting",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				async run(_record, runtime) {
					entered.resolve();
					await new Promise<void>((resolve) =>
						runtime.signal.addEventListener("abort", () => resolve(), { once: true }),
					);
				},
			},
			async abort() {},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "waiting", tasks: [task] }));
		const storage = new Storage();
		const reports: unknown[] = [];
		const harness = await Harness.open(
			storage,
			{ registry, models: createModels(), onReport: (error) => reports.push(error) },
			context,
		);
		try {
			const root = await harness.root(context);
			await root.commit((tx) => tx.createTask(task, null, { ownership: { kind: "conversation" } }), context);
			harness.resume();
			await entered.promise;
			storage.failWrites = true;
			await harness.close(context);
			expect(storage.closeCalls).toBe(1);
			expect(await harness.closed).toEqual({ reason: "failed", error: failure });
			expect(reports).toEqual([failure]);
			await harness.close(context);
			expect(storage.closeCalls).toBe(1);
		} finally {
			await harness.close(context).catch(() => {});
			if (!storage.closeCalls) await storage.close(context);
		}
	});
	it("reports a missing task migration in the graph before scheduling", async () => {
		const versioned = (version: number) =>
			defineTask<null, { phase: "run" }, null>({
				name: "versioned",
				version,
				initial: () => ({ phase: "run" }),
				phases: { async run() {} },
				async abort() {},
			});
		const task = versioned(1);
		const registry = createRegistry();
		registry.install(defineExtension({ name: "versioned", tasks: [task] }));
		const harness = await Harness.open(new MemoryStorage(), { registry, models: createModels() }, context);
		try {
			const root = await harness.root(context);
			const id = await root.commit((tx) => tx.createTask(task, null, { ownership: { kind: "conversation" } }), context);
			registry.install(defineExtension({ name: "versioned", tasks: [versioned(2)] }));
			const graph = await harness.watchTaskGraph(context);
			try {
				expect(graph.value.tasks[String(id)]?.blocked).toBe("migration_failed");
				expect((await harness.inspect(context)).tasks[0]?.state).toMatchObject({ reason: "migration_failed" });
			} finally {
				await graph.stop();
			}
		} finally {
			await harness.close(context);
		}
	});
	it("exposes the default policies to applications", () => {
		expect(DEFAULT_RESTART_LIMIT).toBe(5);
		expect(DEFAULT_RETRY_POLICY).toEqual({ enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60000 });
		expect(DEFAULT_COMPACTION_POLICY).toEqual({
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
			backgroundTokens: 32768,
		});
		expect(DEFAULT_PROGRESS_POLICY).toEqual({ partialIntervalMs: 100, outputIntervalMs: 100 });
	});
	it("publishes the first compaction status in its creating transaction", async () => {
		const session = createSession(new MemoryStorage());
		try {
			const conversation = await session.commit(
				(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
				context,
			);
			const id = await session.commit((tx) => createCompaction(tx, conversation.id, { reason: "manual" }), context);
			expect((await session.snapshot(LiveDoc, conversation.id, context))?.compactions).toEqual([
				{ taskId: id, reason: "manual", blocking: false, attempt: 1 },
			]);
		} finally {
			await session.close(context);
		}
	});
	it("retains provider identity after reopen and gives a fork a fresh identity", async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-state-"));
		let session = createSession(await openNodeJsonlStorage(directory, context));
		try {
			const root = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
			const point = await session.commit(async (tx) => {
				await configure(tx, root.id, { model: { provider: "example", modelId: "first" }, cwd: "/work" });
				await tx.doc(ProviderDoc, root.id);
				return tx.appendEntry(root.id, { kind: "saved" });
			}, context);
			const initial = (await session.snapshot(ProviderDoc, root.id, context))!.sessionId;
			expect(initial).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
			await session.commit(
				(tx) => configure(tx, root.id, { model: { provider: "example", modelId: "second" } }),
				context,
			);
			await session.close(context);
			session = createSession(await openNodeJsonlStorage(directory, context));
			expect((await session.snapshot(ProviderDoc, root.id, context))?.sessionId).toBe(initial);
			const fork = await session.commit(async (tx) => {
				const child = await tx.forkConversation(root.id, point.id, { ownership: { kind: "ownerless" } });
				await tx.doc(ProviderDoc, child.id);
				return child;
			}, context);
			expect(await session.snapshot(AgentDoc, fork.id, context)).toEqual({
				model: { provider: "example", modelId: "first" },
				cwd: "/work",
			});
			const childId = (await session.snapshot(ProviderDoc, fork.id, context))!.sessionId;
			expect(childId).not.toBe(initial);
			await session.close(context);
			session = createSession(await openNodeJsonlStorage(directory, context));
			expect((await session.snapshot(ProviderDoc, fork.id, context))?.sessionId).toBe(childId);
		} finally {
			await session.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("records usage for a tool named like an object prototype property", async () => {
		const session = createSession(new MemoryStorage());
		const root = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
		const usage = {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			reasoning: 1,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		};
		await session.commit(async (tx) => {
			await recordUsage(tx, root.id, "tools", "__proto__", usage);
			await recordUsage(tx, root.id, "tools", "__proto__", usage);
		}, context);
		expect((await session.snapshot(UsageDoc, root.id, context))?.tools["__proto__"]).toEqual({
			input: 2,
			output: 4,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 6,
			reasoning: 2,
			cost: { input: 0.2, output: 0.4, cacheRead: 0, cacheWrite: 0, total: 0.6 },
		});
		await session.close(context);
	});
	it("reads only the appended range and returns independent view arrays", async () => {
		class Storage extends MemoryStorage {
			scanned = 0;
			override async scanEntries(...args: Parameters<MemoryStorage["scanEntries"]>) {
				const page = await super.scanEntries(...args);
				this.scanned += page.items.length;
				return page;
			}
		}
		const storage = new Storage(),
			session = new SessionImpl(storage);
		const root = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
		for (let index = 0; index < 20; index++)
			await session.commit(
				(tx) =>
					tx.appendEntry(root.id, {
						kind: "message",
						model: [{ role: "user", content: `line ${index}`, timestamp: index }],
					}),
				context,
			);
		const first = await readContextFrom(session, storage, root.id, context, undefined, undefined);
		storage.scanned = 0;
		await session.commit((tx) => tx.appendEntry(root.id, { kind: "note", data: 1 }), context);
		const next = await readContextFrom(session, storage, root.id, context, undefined, first.range);
		expect(storage.scanned).toBe(2);
		expect(first.view.entries).toHaveLength(20);
		expect(next.view.entries).toHaveLength(21);
		expect(next.view.messages).toHaveLength(20);
		expect(Object.isFrozen(next.view.entries[0])).toBe(true);
		await session.close(context);
	});
	it("retains a failing section's shown text and propagates cancellation", async () => {
		const failure = new Error("renderer failed"),
			reports: unknown[] = [];
		const input: PromptInput = {
			conversationId: 1 as never,
			agent: { thinkingLevel: "off", extensions: [], tools: [], callable: [], deferred: [], sections: [] },
			env: undefined,
			shown: {},
			read: { snapshot: async () => undefined, snapshotAsOf: async () => undefined },
		};
		const sections = [
			{ key: "one", render: () => "new" },
			{
				key: "two",
				render: () => {
					throw failure;
				},
			},
		];
		expect([
			...(await renderSections(sections, input, new Map([["two", "kept"]]), (error) => reports.push(error), context)),
		]).toEqual([
			["one", "<one>\nnew\n</one>"],
			["two", "kept"],
		]);
		expect(reports).toEqual([failure]);
		await expect(
			renderSections(sections, input, new Map(), () => {}, withAbortSignal(AbortSignal.abort(), context)),
		).rejects.toBe(failure);
	});
});

import { createCompaction } from "../src/harness/compaction.ts";
import { LiveDoc } from "../src/harness/live.ts";
