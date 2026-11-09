import { createModels } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test, vi } from "vitest";
import {
	createRegistry,
	defineExtension,
	defineTask,
	Harness,
	MemoryStorage,
	type Report,
	type SetTimer,
} from "../src/index.ts";

test.each(["advance", "close"])("sleeping work owns a foreground wake timer until %s", async (action) => {
	let now = 1000,
		completions = 0;
	const timers: Array<{ delay: number; background: boolean; active: boolean; fire(): void }> = [];
	const setTimer: SetTimer = (callback, delay, options) => {
		const timer = {
			delay,
			background: options.background,
			active: true,
			fire() {
				if (!timer.active) throw new Error("Cancelled timer fired");
				timer.active = false;
				callback();
			},
		};
		timers.push(timer);
		return () => {
			timer.active = false;
		};
	};
	const task = defineTask<null, { phase: "wait" | "finish" }, number>({
		name: "wake-timer",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async (_record, runtime, frame) =>
				runtime.commit(() => ({ status: "sleeping", checkpoint: { phase: "finish" }, until: 1100 }), frame),
			finish: async (_record, runtime, frame) => {
				completions++;
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: 42 } }), frame);
			},
		},
		abort: async (_record, runtime, frame) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), frame),
	});
	const registry = createRegistry(),
		storage = new MemoryStorage();
	registry.install(defineExtension({ name: "wake-timers", tasks: [task] }));
	const harness = await Harness.open(storage, { models: createModels(), registry, setTimer, now: () => now }, context);
	try {
		const root = await harness.root(context);
		const id = await root.commit((tx) => tx.createTask(task, null, { ownership: { kind: "conversation" } }), context);
		harness.resume();
		await vi.waitFor(() =>
			expect(timers.some((timer) => timer.active && !timer.background && timer.delay === 100)).toBe(true),
		);
		const wake = timers.find((timer) => timer.active && !timer.background && timer.delay === 100);
		if (!wake) throw new Error("Missing wake timer");
		expect(completions).toBe(0);
		if (action === "advance") {
			now = 1100;
			wake.fire();
			await vi.waitFor(async () =>
				expect((await storage.task(id, context))?.state).toEqual({
					status: "terminal",
					outcome: { status: "completed", result: 42 },
				}),
			);
			expect(completions).toBe(1);
		} else {
			await harness.close(context);
			expect(wake.active).toBe(false);
			expect(completions).toBe(0);
		}
	} finally {
		await harness.close(context);
	}
	expect(timers.filter((timer) => timer.active)).toEqual([]);
});

test("a failing host wake callback is reported without preventing durable task completion", async () => {
	const failure = new Error("Wake handler failed"),
		reports: Report[] = [];
	const task = defineTask<number, { phase: "run" }, number>({
		name: "wake-failure",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			async run(record, runtime, ctx) {
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: record.input + 1 } }),
					ctx,
				);
			},
		},
		async abort() {},
	});
	const registry = createRegistry(),
		storage = new MemoryStorage();
	registry.install(defineExtension({ name: "wake-failure", tasks: [task] }));
	const harness = await Harness.open(
		storage,
		{
			models: createModels(),
			registry,
			onWake() {
				throw failure;
			},
			onReport: (report) => reports.push(report),
		},
		context,
	);
	try {
		const root = await harness.root(context);
		const id = await root.commit((tx) => tx.createTask(task, 41, { ownership: { kind: "conversation" } }), context);
		harness.resume();
		await vi.waitFor(async () =>
			expect((await storage.task(id, context))?.state).toEqual({
				status: "terminal",
				outcome: { status: "completed", result: 42 },
			}),
		);
		expect(reports).toContainEqual({ kind: "host_error", callback: "onWake", error: failure });
		expect(reports.every((report) => report.kind === "host_error" && report.callback === "onWake")).toBe(true);
	} finally {
		await harness.close(context);
	}
});

test("a registry unsubscribe failure is reported after its listener detaches and does not prevent closing", async () => {
	const failure = new Error("Registry cleanup failed"),
		reports: Report[] = [],
		definitions = createRegistry();
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models: createModels(),
			registry: {
				snapshot: () => definitions.snapshot(),
				subscribe(listener) {
					const stop = definitions.subscribe(listener);
					return () => {
						stop();
						throw failure;
					};
				},
			},
			onReport: (report) => reports.push(report),
		},
		context,
	);
	try {
		await harness.close(context);
		expect(reports).toContainEqual({ kind: "host_error", callback: "registry", error: failure });
		await expect(harness.root(context)).rejects.toThrow(/closed/);
	} finally {
		await harness.close(context);
	}
});
