import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT, type Context } from "../src/context/index.ts";
import { createHost } from "../src/index.ts";
import { envelope, type FromWorker, type ToWorker } from "../src/node/workers/control.ts";
import { workerMain } from "../src/node/workers/main.ts";
import { processLock } from "../src/node/workers/lock.ts";
import { Watch, type Watchable } from "../src/watch.ts";
import { Runner } from "./fixtures/worker-contracts.ts";

vi.mock("../src/node/workers/lock.ts", () => ({
	processLock: vi.fn(async () => ({ release: async () => {} })),
}));

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function child() {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const events = new EventEmitter();
	const sent: { "objects.workers": FromWorker }[] = [];
	const exit = vi.fn();
	const port = {
		...process,
		connected: true,
		on: events.on.bind(events),
		once: events.once.bind(events),
		removeListener: events.removeListener.bind(events),
		send(message: { "objects.workers": FromWorker }, ...args: unknown[]) {
			sent.push(message);
			const done = args.at(-1);
			if (typeof done === "function") done(null);
			return true;
		},
		disconnect() {
			port.connected = false;
			events.emit("disconnect");
		},
		exit,
	};
	vi.stubGlobal("process", port);
	return {
		port,
		events,
		exit,
		messages: () => sent.map((entry) => entry["objects.workers"]),
		send: (message: ToWorker) => events.emit("message", envelope(message)),
		start: () =>
			events.emit(
				"message",
				envelope({
					kind: "start",
					address: Runner({ id: "entry" }),
					start: { label: "first" },
					scripts: [],
					lock: "entry-lock",
				}),
			),
	};
}

test("the child waits for startup and announces its link before readiness, then applies queued reloads", async () => {
	const f = child();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const errors: unknown[] = [];
	const host = createHost({ onError: (error) => errors.push(error) });
	let context: Context | undefined;
	workerMain(
		async (start, current) => {
			context = current;
			expect(start.start).toEqual({ label: "first" });
			start.parent.onMessage(() => {});
			start.onClose((closing) => host.close(closing));
			await start.plugins.load(host, { kind: "worker", core: [] }, current);
			entered.resolve();
			await release.promise;
			return undefined;
		},
		{ hostPackages: {}, redact: () => ({ message: "redacted" }), onError: (error) => errors.push(error) },
	);
	expect(f.messages()).toEqual([]);
	f.events.emit("message", { unrelated: true });
	f.start();
	await entered.promise;
	expect(processLock).toHaveBeenCalledWith("entry-lock", context);
	expect(f.messages()).toEqual([{ kind: "started" }]);
	f.send({ kind: "reload", scripts: [] });
	release.resolve();
	await vi.waitFor(() =>
		expect(f.messages()).toMatchObject([
			{ kind: "started" },
			{
				kind: "ready",
				idle: true,
				report: { failed: [], objects: [], plugins: { added: [], changed: [], removed: [] } },
			},
			{ kind: "idle", idle: false },
			{ kind: "reloaded", report: { failed: [] } },
			{ kind: "idle", idle: true },
		]),
	);
	f.send({ kind: "shutdown" });
	await vi.waitFor(() => expect(f.exit).toHaveBeenCalledWith(0));
	expect(context?.abortSignal?.aborted).toBe(true);
	expect(errors).toEqual([]);
});

test("application busy counts change idle state and a worker without plugin setup refuses reload", async () => {
	const f = child();
	let value = { pending: 1 };
	let watch: Watch<{ pending: number }> | undefined;
	const busy: Watchable<{ pending: number }> = {
		get value() {
			return value;
		},
		async watch(context) {
			watch = new Watch(
				value,
				() => {},
				() => {},
			);
			if (context.abortSignal) watch.observeAbort(context.abortSignal);
			return watch;
		},
	};
	workerMain(async () => ({ busy }), { hostPackages: {}, redact: () => ({ message: "redacted" }), onError() {} });
	f.start();
	await vi.waitFor(() => expect(f.messages()).toMatchObject([{ kind: "ready", idle: false }]));
	value = { pending: 0 };
	watch!.advance({ kind: "value", value, ops: [["r", value]], retired: false }, BACKGROUND_CONTEXT);
	await vi.waitFor(() => expect(f.messages().at(-1)).toEqual({ kind: "idle", idle: true }));
	f.send({ kind: "reload", scripts: [] });
	await vi.waitFor(() =>
		expect(f.messages()).toContainEqual({
			kind: "reloaded",
			error: { message: "worker: plugins.load was never called" },
		}),
	);
	f.port.disconnect();
	await vi.waitFor(() => expect(f.exit).toHaveBeenCalledWith(0));
	expect(await watch!.closed).toEqual({ kind: "aborted" });
});

test("shutdown is idempotent, runs closers in reverse order and retains failures for the local reporter", async () => {
	const f = child();
	const order: string[] = [];
	const failure = new Error("closer failed");
	const errors: unknown[] = [];
	workerMain(
		async ({ onClose }) => {
			onClose(() => {
				order.push("first");
			});
			onClose(() => {
				order.push("last");
				throw failure;
			});
			return undefined;
		},
		{ hostPackages: {}, redact: () => ({ message: "redacted" }), onError: (error) => errors.push(error) },
	);
	f.start();
	await vi.waitFor(() => expect(f.messages()).toHaveLength(1));
	f.events.emit("SIGINT");
	f.events.emit("SIGTERM");
	f.send({ kind: "shutdown" });
	f.send({ kind: "reload", scripts: [] });
	await vi.waitFor(() => expect(f.exit).toHaveBeenCalledExactlyOnceWith(0));
	expect(order).toEqual(["last", "first"]);
	expect(errors).toEqual([failure]);
	expect(f.messages()).toHaveLength(1);
});

test.each(["returns", "rejects"] as const)(
	"startup that %s after shutdown cannot announce readiness or a fatal failure",
	async (outcome) => {
		const f = child();
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const errors: unknown[] = [];
		workerMain(
			async ({ onClose }, context) => {
				onClose(() => {
					expect(context.abortSignal?.aborted).toBe(true);
				});
				entered.resolve();
				await released.promise;
				return undefined;
			},
			{ hostPackages: {}, redact: () => ({ message: "redacted" }), onError: (error) => errors.push(error) },
		);
		f.start();
		await entered.promise;
		f.send({ kind: "reload", scripts: [] });
		f.send({ kind: "shutdown" });
		await vi.waitFor(() => expect(f.exit).toHaveBeenCalledExactlyOnceWith(0));
		if (outcome === "returns") released.resolve();
		else released.reject(new Error("startup cancelled"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(f.messages()).toEqual([]);
		expect(errors).toEqual([]);
	},
);

test.each(["failure", "redactor-failure", "disconnected"] as const)(
	"fatal startup errors use the public error boundary: %s",
	async (mode) => {
		const f = child();
		const failure = new Error("private startup details");
		const errors: unknown[] = [];
		workerMain(
			async () => {
				throw failure;
			},
			{
				hostPackages: {},
				redact() {
					if (mode === "redactor-failure") throw new Error("redaction failed");
					return { message: "public failure" };
				},
				onError: (error) => errors.push(error),
			},
		);
		if (mode === "disconnected") f.port.connected = false;
		f.start();
		await vi.waitFor(() => expect(f.exit).toHaveBeenCalledWith(1));
		expect(errors).toEqual([failure]);
		if (mode !== "disconnected")
			expect(f.messages()).toEqual([
				{ kind: "fatal", error: { message: mode === "failure" ? "public failure" : "worker: fatal error" } },
			]);
	},
);
