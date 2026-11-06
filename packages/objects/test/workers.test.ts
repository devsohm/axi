import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "../src/context/index.ts";
import { createHost } from "../src/index.ts";
import { createPlugins } from "../src/node/plugins/index.ts";
import { clearStaleLock } from "../src/node/workers/lock.ts";
import { createWorkers, processLock, type WorkersError } from "../src/node/workers/index.ts";
import { Control, Runner, Value } from "./fixtures/worker-contracts.ts";

vi.mock("../src/node/workers/lock.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/node/workers/lock.ts")>();
	return { ...original, clearStaleLock: vi.fn(original.clearStaleLock) };
});

async function setup(onOutput: () => void = () => {}) {
	const directory = await mkdtemp(join(tmpdir(), "axi-workers-"));
	const plugins = createPlugins(
		{ roots: [directory], kinds: { worker: { platform: "node", hostPackages: ["@axi/objects"] } }, onError() {} },
		context,
	);
	const host = createHost({ principal: { kind: "server" }, onError() {} });
	const errors: WorkersError[] = [];
	let starts = 0,
		fail = false;
	const addresses: WeakRef<object>[] = [];
	const workers = await createWorkers(
		host,
		Runner,
		{
			kind: "worker",
			entry: fileURLToPath(new URL("./fixtures/runtime-worker.ts", import.meta.url)),
			execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
			authorize: () => true,
			principal: () => ({ kind: "worker" }),
			start: (address) => {
				addresses.push(new WeakRef(address));
				starts++;
				if (fail) throw new Error("private start failure");
				return "started";
			},
			lock: (address) => `${directory}:${address.key}`,
			idleMs: () => 0,
			plugins,
			onOutput,
			onError: (error) => errors.push(error),
		},
		context,
	);
	await host.load([], context);
	return {
		directory,
		host,
		workers,
		plugins,
		errors,
		addresses,
		starts: () => starts,
		fail(value: boolean) {
			fail = value;
		},
		async [Symbol.asyncDispose]() {
			await workers.close(context);
			await host.close(context);
			plugins.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

it("calls the worker output callback without binding an options object", async () => {
	const receivers: unknown[] = [];
	await using f = await setup(function (this: unknown) {
		receivers.push(this);
	});
	const ref = await f.host.get(Control, { id: "output" }, context);
	try {
		await vi.waitFor(() => expect(receivers.length).toBeGreaterThan(0));
		expect(receivers.every((receiver) => receiver === undefined)).toBe(true);
	} finally {
		ref.release();
	}
});

it("waits for a killed worker's queued lock cleanup before close resolves", async () => {
	await using f = await setup();
	const ref = await f.host.get(Control, { id: "close-drain" }, context);
	await vi.waitFor(() => expect(f.workers.state.value["runner|close-drain"]?.status).toBe("running"));
	const worker = f.workers.state.value["runner|close-drain"];
	if (!worker || !("pid" in worker)) throw new Error("Worker did not start");
	const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<boolean>();
	vi.mocked(clearStaleLock).mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
	let finished = false;
	process.kill(worker.pid, "SIGKILL");
	const closing = f.workers.close(context).then(() => { finished = true; });
	try {
		await entered.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(finished).toBe(false);
		gate.resolve(false);
		await closing;
		expect(finished).toBe(true);
	} finally {
		gate.resolve(false);
		await closing;
		ref.release();
	}
});

it("starts a process on demand, carries start data and stops it after its last reference goes idle", async () => {
	await using f = await setup();
	const ref = await f.host.get(Control, { id: "first" }, context);
	expect(ref.label.value).toBe("started");
	expect(await ref.echo("hello", context)).toBe("hello");
	expect(f.starts()).toBe(1);
	expect(f.workers.state.value["runner|first"]).toMatchObject({ status: "running", pid: expect.any(Number) });
	ref.release();
	await vi.waitFor(() => expect(f.workers.state.value).toEqual({}), { timeout: 3000 });
	expect(f.errors).toEqual([]);
});

it("keeps a crash failed until an explicit retry creates a new process", async () => {
	await using f = await setup();
	const ref = await f.host.get(Control, { id: "restart" }, context);
	const first = f.workers.state.value["runner|restart"];
	await ref.crash(context);
	await vi.waitFor(() =>
		expect(f.workers.state.value["runner|restart"]).toMatchObject({
			status: "failed",
			error: { message: "worker exited (code 3)" },
		}),
	);
	expect(f.starts()).toBe(1);
	expect(ref.label.value).toBe("started");
	const paused = await ref.label.watch(context);
	expect(paused.value).toBe("started");
	const frames: string[] = [];
	paused.start(async (frame) => {
		frames.push(frame.kind);
	});
	await vi.waitFor(() => expect(frames).toEqual(["failed"]));
	await paused.stop();
	await f.workers.retry(Runner({ id: "restart" }), context);
	await vi.waitFor(() => expect(ref.state.value).toEqual({ kind: "live" }));
	expect(f.workers.state.value["runner|restart"]).not.toEqual(first);
	expect(await ref.echo("after restart", context)).toBe("after restart");
	expect(f.starts()).toBe(2);
	ref.release();
});

it("recovers a running worker's lost link once and blocks another loss within a minute", async () => {
	await using f = await setup();
	const ref = await f.host.get(Control, { id: "lost-link" }, context);
	try {
		await ref.loseLink(context);
		await vi.waitFor(
			() => {
				expect(f.starts()).toBe(2);
				expect(ref.state.value.kind).toBe("live");
			},
			{ timeout: 9000 },
		);
		expect(f.errors.map(({ kind }) => kind)).toEqual(["worker_link_lost"]);
		expect(await ref.echo("reconnected", context)).toBe("reconnected");
		await ref.loseLink(context);
		await vi.waitFor(
			() =>
				expect(f.workers.state.value["runner|lost-link"]).toMatchObject({
					status: "failed",
					error: { message: "worker lost its link" },
				}),
			{ timeout: 9000 },
		);
		expect(f.starts()).toBe(2);
		expect(f.errors.map(({ kind }) => kind)).toEqual(["worker_link_lost", "worker_exited", "worker_failed"]);
	} finally {
		ref.release();
	}
}, 25000);

it("reports a fixed public start error and retains the full error only in the host callback", async () => {
	await using f = await setup();
	f.fail(true);
	const ref = f.host.hold(Control, { id: "failed" }, context);
	await vi.waitFor(() =>
		expect(f.workers.state.value["runner|failed"]).toMatchObject({
			status: "failed",
			error: { message: "worker failed to start" },
		}),
	);
	expect(JSON.stringify(f.workers.state.value)).not.toContain("private start failure");
	expect(f.errors).toMatchObject([{ kind: "worker_failed", error: new Error("private start failure") }]);
	f.fail(false);
	await f.workers.retry(Runner({ id: "failed" }), context);
	await vi.waitFor(() => expect(ref.state.value).toEqual({ kind: "live" }));
	ref.release();
});

it("ships a plugin update to a running child and gives later children the same current scripts", async () => {
	await using f = await setup();
	const directory = join(f.directory, "value");
	await mkdir(directory);
	await writeFile(join(directory, "package.json"), JSON.stringify({ name: "value", type: "module" }));
	const source = (text: string) => `import {hostKind,str,remote,defineFacet,constant} from "@axi/objects";
const Runner=hostKind("runner",{id:str()});const Value=remote("runtime.value",{version:1,params:{id:str()},hostAddress:({id})=>Runner({id}),variants:{active:{state:{text:str()},methods:{}}}});
export default defineFacet(host=>host.serve(Value,()=>({variant:"active",members:{text:constant(${JSON.stringify(text)})}})));`;
	await writeFile(join(directory, "worker.ts"), source("before"));
	await f.plugins.build(["value"], context);
	const ref = await f.host.get(Value, { id: "loaded" }, context);
	expect(ref.text.value).toBe("before");
	await writeFile(join(directory, "worker.ts"), source("after"));
	const result = await f.plugins.rollout(
		[f.workers.step("children")],
		await f.plugins.build(["value"], context),
		context,
	);
	expect(result.stopped).toBeUndefined();
	expect(result.steps[0]?.hosts).toMatchObject([{ host: "runner|loaded", report: { failed: [] } }]);
	await vi.waitFor(() => expect(ref.text.value).toBe("after"));
	const later = await f.host.get(Value, { id: "later" }, context);
	expect(later.text.value).toBe("after");
	ref.release();
	later.release();
});

it("cancels a lock waiter and grants the lock after its holder releases it", async () => {
	const name = `axi-lock-test:${process.pid}:${Date.now()}`;
	const first = await processLock(name, context),
		controller = new AbortController();
	const waiting = processLock(name, withAbortSignal(controller.signal, context));
	controller.abort(new Error("stop waiting"));
	await expect(waiting).rejects.toThrow("stop waiting");
	const next = processLock(name, context);
	await first.release();
	const second = await next;
	await second.release();
});

it("releases a stopped worker's address while the supervisor remains open", async () => {
	await using f = await setup();
	await (async () => {
		const ref = await f.host.get(Control, { id: "collect" }, context);
		ref.release();
		await f.workers.stop(Runner({ id: "collect" }), context);
	})();
	setFlagsFromString("--expose-gc");
	const gc: () => void = runInNewContext("gc");
	for (let attempt = 0; attempt < 10; attempt++) {
		await new Promise((resolve) => setImmediate(resolve));
		gc();
	}
	expect(f.addresses.map((address) => address.deref())).toEqual([undefined]);
});
