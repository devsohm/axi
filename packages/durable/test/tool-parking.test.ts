import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@axi/ai";
import { BACKGROUND_CONTEXT as context, awaitWithContext } from "@axi/objects/context";
import { expect, test, vi } from "vitest";
import { SCHEDULER_IDLE_STATE } from "../src/harness/harness.ts";
import {
	createRegistry,
	defineExtension,
	defineSignal,
	defineTask,
	defineTool,
	Harness,
	hook,
	LiveDoc,
	MemoryStorage,
	ToolTask,
	wrapTool,
	type Extension,
	type HookRegistration,
	type TaskId,
	type ToolRegistration,
	type WakeReason,
} from "../src/index.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";

const Result = defineSignal({ name: "jobs.result", version: 1, schema: Type.String() });

async function start(
	tools: readonly ToolRegistration[],
	hooks: readonly HookRegistration[] = [],
	now = () => Date.now(),
	extensions: readonly Extension[] = [],
) {
	const registry = createRegistry(),
		models = createModels(),
		provider = fauxProvider();
	models.setProvider(provider.provider);
	registry.install(defineExtension({ name: "jobs", tools, hooks }));
	for (const extension of extensions) registry.install(extension);
	provider.setResponses([
		fauxAssistantMessage([fauxToolCall(tools[0]!.name, {}, { id: "job" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Finished"),
	]);
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models, registry, now, onWake: () => {}, settings: { contextRetentionMs: 0, compaction: { enabled: false } } },
		context,
	);
	const conversation = await harness.root(context, {
		agent: { model: { provider: provider.provider.id, modelId: provider.getModel().id } },
	});
	const input = await conversation.submit({ type: "input", content: "Run the job" }, context);
	return { harness, conversation, input, registry };
}
async function sleeping(f: Awaited<ReturnType<typeof start>>, phase: "call" | "parked" = "parked") {
	const find = async () =>
		(await f.harness.inspect(context)).tasks.find(
			(task) =>
				task.record.kind === "axi.tool" &&
				task.record.state.status === "sleeping" &&
				(task.record.state.checkpoint as { phase: string }).phase === phase,
		)?.record;
	await vi.waitFor(async () => expect(await find()).toBeDefined(), { timeout: 800 });
	return (await find())!;
}

test("a tool releases its invocation while parked and keeps details until its final result", async () => {
	const runs: { wake: WakeReason | undefined; checkpoint: unknown }[] = [];
	const work = defineTool({
		name: "work",
		description: "Wait for external work",
		parameters: Type.Object({}),
		async execute(_args, api, ctx) {
			runs.push({ wake: api.wake, checkpoint: api.checkpoint });
			const result = await api.readSignal(Result, "finished", ctx);
			if (result && "value" in result) return { output: [{ type: "text", text: result.value }] };
			api.output("Transient log");
			api.diagnostic({ severity: "info", message: "Job submitted" });
			void api.details({ job: "r42" }, ctx).catch(() => {});
			return { sleep: { signals: [Result.key("finished")], checkpoint: { job: "r42" } } };
		},
	});
	const f = await start([work]);
	try {
		const task = await sleeping(f);
		await vi.waitFor(() => expect(f.harness.wake().active).toBe(false));
		expect(Reflect.get(f.harness, SCHEDULER_IDLE_STATE)).toMatchObject({
			contexts: 0,
			idleContexts: 0,
			idleMismatches: 0,
		});
		const slot = (await f.harness.snapshot(LiveDoc, f.conversation.id, context))?.tools?.[0];
		expect(slot).toMatchObject({
			status: "sleeping",
			details: { job: "r42" },
			diagnostics: [{ message: "Job submitted" }],
		});
		expect(slot?.output).toBeUndefined();
		expect(await f.harness.signal(task.id, Result, "finished", "External result", context)).toBe("delivered");
		expect(await f.input.wait(context)).toMatchObject({ status: "done" });
		expect(runs).toEqual([
			{ wake: undefined, checkpoint: undefined },
			{ wake: { reason: "signal", signal: Result.name, key: "finished" }, checkpoint: { job: "r42" } },
		]);
		const result = (await f.conversation.context(context)).messages.find((message) => message.role === "toolResult");
		expect(result).toMatchObject({
			details: { job: "r42" },
			content: [
				{ type: "text", text: "External result" },
				{ type: "text", text: "<harness>\n[info] Job submitted\n</harness>" },
			],
		});
	} finally {
		await f.harness.close(context);
	}
});

test("a timed tool park includes its wait in the reported duration", async () => {
	let clock = 10000;
	const f = await start(
		[
			defineTool({
				name: "timer",
				description: "Wait for a deadline",
				parameters: Type.Object({}),
				async execute(_args, api) {
					return api.wake ? { output: [] } : { sleep: { until: api.now() + 450 } };
				},
			}),
		],
		[],
		() => clock,
	);
	try {
		await sleeping(f);
		clock += 450;
		f.harness.resume();
		await f.input.wait(context);
		expect(
			(await f.conversation.context(context)).messages.find((message) => message.role === "toolResult"),
		).toMatchObject({ durationMs: 450 });
	} finally {
		await f.harness.close(context);
	}
});

test("aborting a parked tool calls its cleanup with the checkpoint and blocks new child work", async () => {
	const cleaned: unknown[] = [];
	const f = await start([
		defineTool({
			name: "external",
			description: "Wait for an external job",
			parameters: Type.Object({}),
			async execute() {
				return { sleep: { signals: [Result.key("done")], checkpoint: "external-id" } };
			},
			async cancel(_args, api, ctx) {
				cleaned.push([api.checkpoint, api.wake]);
				expect(() => api.executeTool("external", {}, ctx)).toThrow("cannot start");
			},
		}),
	]);
	try {
		const task = await sleeping(f);
		await f.conversation.abort(context);
		expect(cleaned).toEqual([["external-id", undefined]]);
		expect((await f.harness.getTask(task.id, context))?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "aborted" },
		});
	} finally {
		await f.harness.close(context);
	}
});

test.each(["signal", "uninstall"] as const)("a gate is re-evaluated after %s before a tool can run", async (action) => {
	let ran = 0,
		gates = 0;
	const f = await start(
		[
			defineTool({
				name: "guarded",
				description: "Run after approval",
				parameters: Type.Object({}),
				async execute() {
					ran++;
					return { output: [] };
				},
			}),
		],
		[
			hook(ToolTask, {
				async beforeTool(_call, api, ctx) {
					gates++;
					return (await api.readSignal(Result, "approved", ctx))
						? undefined
						: { sleep: { signals: [Result.key("approved")] } };
				},
			}),
		],
	);
	try {
		const task = await sleeping(f, "call");
		await vi.waitFor(() => expect(f.harness.wake().active).toBe(false));
		expect(ran).toBe(0);
		if (action === "signal") await f.harness.signal(task.id, Result, "approved", "yes", context);
		else {
			f.registry.install(
				defineExtension({
					name: "jobs",
					tools: [
						defineTool({
							name: "guarded",
							description: "Run after approval",
							parameters: Type.Object({}),
							async execute() {
								ran++;
								return { output: [] };
							},
						}),
					],
				}),
			);
			expect(f.harness.wake()).toEqual({ active: true });
		}
		await f.input.wait(context);
		expect(ran).toBe(1);
		expect(gates).toBe(action === "signal" ? 2 : 1);
	} finally {
		await f.harness.close(context);
	}
});

test("nonblocking nested calls survive their parent parking and are reused by key", async () => {
	const seen: number[] = [];
	const parent = defineTool({
		name: "parent",
		description: "Coordinate a child",
		parameters: Type.Object({}),
		async execute(_args, api, ctx) {
			const child = await api.executeTool("child", {}, ctx, { key: "item", wait: false });
			seen.push(child.taskId);
			if (!api.wake) return { wait: { on: [child.taskId], policy: "allSettled" } };
			return { output: [{ type: "text", text: String((await child.result(ctx)).structuredOutput) }] };
		},
	});
	const child = defineTool({
		name: "child",
		description: "Wait for a result",
		parameters: Type.Object({}),
		async execute(_args, api, ctx) {
			const result = await api.readSignal(Result, "child", ctx);
			return result && "value" in result
				? { output: [{ type: "text", text: result.value }] }
				: { sleep: { signals: [Result.key("child")] } };
		},
	});
	const f = await start([parent, child]);
	try {
		const task = await sleeping(f);
		await vi.waitFor(() => expect(f.harness.wake().active).toBe(false));
		await f.harness.signal(task.id, Result, "child", "Nested result", context);
		await f.input.wait(context);
		expect(seen).toHaveLength(2);
		expect(seen[0]).toBe(seen[1]);
		expect(JSON.stringify((await f.conversation.context(context)).messages)).toContain("Nested result");
	} finally {
		await f.harness.close(context);
	}
});

test("a tool can park on a keyed child task without creating it again after wake", async () => {
	const Child = defineTask<null, { phase: "done" }, null>({
		name: "jobs.child",
		version: 1,
		initial: () => ({ phase: "done" }),
		phases: {
			done: (_task, api, ctx) =>
				api.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
		},
		abort: (_task, api, ctx) => api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	});
	const ids: number[] = [];
	const f = await start(
		[
			defineTool({
				name: "coordinate",
				description: "Coordinate work",
				parameters: Type.Object({}),
				async execute(_args, api, ctx) {
					const id = await api.createTask(
						Child,
						null,
						{ ownership: { kind: "task", taskId: api.taskId }, key: "child" },
						ctx,
					);
					ids.push(id);
					return api.wake ? { output: [] } : { wait: { on: [id], policy: "allSettled" } };
				},
			}),
		],
		[],
		undefined,
		[defineExtension({ name: "children", tasks: [Child] })],
	);
	try {
		await f.input.wait(context);
		expect(ids).toHaveLength(2);
		expect(ids[0]).toBe(ids[1]);
	} finally {
		await f.harness.close(context);
	}
});

test("a gate that sleeps after a registry publication is immediately re-evaluated", async () => {
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let passes = 0;
	const f = await start(
		[
			defineTool({
				name: "gated",
				description: "Run gated work",
				parameters: Type.Object({}),
				async execute() {
					return { output: [] };
				},
			}),
		],
		[
			hook(ToolTask, {
				async beforeTool() {
					passes++;
					if (passes > 1) return undefined;
					entered.resolve();
					await release.promise;
					return { sleep: { signals: [Result.key("not-delivered")] } };
				},
			}),
		],
	);
	try {
		await entered.promise;
		f.registry.install(defineExtension({ name: "new-capabilities" }));
		release.resolve();
		await vi.waitFor(() => expect(passes).toBe(2), { timeout: 800 });
		expect(await f.input.wait(context)).toMatchObject({ status: "done" });
	} finally {
		release.resolve();
		await f.harness.close(context);
	}
});

test.each([false, true])("a wrapper must return its base's park object unchanged (cloned: %s)", async (clone) => {
	const tool = defineTool({
		name: "wrapped",
		description: "Wait for a wrapped job",
		parameters: Type.Object({}),
		async execute(_args, api, ctx) {
			return (await api.readSignal(Result, "done", ctx))
				? { output: [] }
				: { sleep: { signals: [Result.key("done")] } };
		},
	});
	const wrapper = defineExtension({
		name: "wrapping",
		wraps: [
			wrapTool(tool, (base) => ({
				...base,
				async execute(args, api, ctx) {
					const value = await base.execute(args, { ...api }, ctx);
					return clone && value.sleep !== undefined ? { sleep: { ...value.sleep } } : value;
				},
			})),
		],
	});
	const f = await start([tool], [], undefined, [wrapper]);
	try {
		if (!clone) await f.harness.signal((await sleeping(f)).id, Result, "done", "ready", context);
		await f.input.wait(context);
		const message = (await f.conversation.context(context)).messages.find((message) => message.role === "toolResult");
		expect(message).toMatchObject({ isError: clone });
		if (clone) expect(JSON.stringify(message)).toContain("a wrapper returned a park its base did not return");
	} finally {
		await f.harness.close(context);
	}
});

test("reopening an interrupted unsafe caller abandons all of its parked children in one pass", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-unsafe-children-")),
		path = join(directory, "session.sqlite");
	const registry = createRegistry(),
		models = createModels(),
		provider = fauxProvider();
	models.setProvider(provider.provider);
	const started = Promise.withResolvers<void>(),
		blocked = Promise.withResolvers<void>();
	let children: TaskId[] = [],
		cancelled = 0;
	registry.install(
		defineExtension({
			name: "jobs",
			tools: [
				defineTool({
					name: "parent",
					description: "Start two external jobs",
					parameters: Type.Object({}),
					async execute(_args, api, ctx) {
						const handles = await Promise.all(
							["first", "second"].map((key) => api.executeTool("child", {}, ctx, { key, wait: false })),
						);
						children = handles.map((handle) => handle.taskId);
						started.resolve();
						await awaitWithContext(blocked.promise, ctx);
						return { output: [] };
					},
				}),
				defineTool({
					name: "child",
					description: "An external job",
					parameters: Type.Object({}),
					async execute() {
						return { sleep: { signals: [Result.key("done")] } };
					},
					async cancel() {
						cancelled++;
					},
				}),
			],
		}),
	);
	provider.setResponses([
		fauxAssistantMessage([fauxToolCall("parent", {}, { id: "parent" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Recovered"),
	]);
	let harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry }, context);
	try {
		const root = await harness.root(context, {
			agent: { model: { provider: provider.provider.id, modelId: provider.getModel().id } },
		});
		const input = await root.submit({ type: "input", content: "Start both jobs" }, context);
		await started.promise;
		await vi.waitFor(async () =>
			expect(
				(await harness.inspect(context)).tasks.filter(
					(task) => children.includes(task.record.id) && task.record.state.status === "sleeping",
				),
			).toHaveLength(2),
		);
		await harness.close(context);
		harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry }, context);
		harness.resume();
		expect(await (await harness.submission(input.id, context))!.wait(context)).toMatchObject({ status: "done" });
		await harness.waitForIdle(context);
		for (const id of children)
			expect((await harness.getTask(id, context))?.state).toMatchObject({
				status: "terminal",
				outcome: { status: "aborted" },
			});
		expect(cancelled).toBe(2);
	} finally {
		blocked.resolve();
		await harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});
