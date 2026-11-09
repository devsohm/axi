import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal, type Context } from "../src/context/index.ts";
import { Routines, type RoutineDeclarations, type RoutineOwner } from "../src/host/routines.ts";
import type { HostError } from "../src/host/report.ts";
import { Batch, Source } from "../src/state/internal.ts";
import { constant, createHost, defineFacet, int, local, ObjectsError } from "../src/index.ts";
import type { FollowObserver } from "../src/host/follow.ts";

it("reports each expired drain when a routine ignores cancellation during reload", async () => {
	const Value = local("routine.draining", { version: 1, params: {}, members: { value: int() } });
	const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), errors: HostError[] = [];
	const host = createHost({ closeTimeout: 15, reloadDrainTimeout: 15, onError(error) { errors.push(error); } });
	const plugin = (n: number) => ({ name: "value", facet: defineFacet((h) => h.serve(Value, (_, self) => {
		self.onLive(async () => {
			if (n === 1) { started.resolve(); await gate.promise; }
		});
		return { value: constant(n) };
	})) });
	try {
		await host.load([plugin(1)], context);
		const ref = await host.get(Value, {}, context);
		await started.promise;
		await host.reload([plugin(2)], context);
		await vi.waitFor(() => expect(ref.value.value).toBe(2));
		expect(errors.map((error) => error.kind)).toEqual(["drain_timeout", "drain_timeout"]);
		ref.release();
	} finally {
		gate.resolve();
		await host.close(context);
	}
});

it.each(["reload", "failure"] as const)("preserves the cancellation cause when a routine stops after %s", async (mode) => {
	const Value = local("routine.cause", { version: 1, params: {}, members: { value: int() } });
	const started = Promise.withResolvers<Context>(), attached = Promise.withResolvers<FollowObserver<unknown>>();
	const plugin = () => ({ name: "value", facet: defineFacet((h) => h.serve(Value, (_, self) => {
		const value = self.follow(async (observer) => {
			attached.resolve(observer);
			return { value: 1, detach() {} };
		});
		self.onLive((ctx) => new Promise<void>((resolve) => {
			started.resolve(ctx);
			ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
		}));
		return { value };
	})) });
	const host = createHost({ onError() {} });
	try {
		await host.load([plugin()], context);
		const ref = await host.get(Value, {}, context), ctx = await started.promise;
		if (mode === "reload") {
			await host.reload([plugin()], context);
			expect(ctx.abortSignal?.reason).toMatchObject({ code: "released", reason: "ended", message: "routine.cause: reloaded" });
		} else {
			const failure = new ObjectsError({ code: "unavailable", message: "runtime disconnected" });
			(await attached.promise).end({ kind: "failed", error: failure });
			expect(ctx.abortSignal?.reason).toBe(failure);
		}
		ref.release();
	} finally {
		await host.close(context);
	}
});

class Values extends Source {
	#n = 0;
	#retired = false;
	get value(): number {
		return this.#n;
	}
	set(n: number, retired = false): void {
		this.#n = n;
		this.#retired ||= retired;
		this.batch.within(() => this.changed(), context);
	}
	deliver(context: Context): void {
		const retired = this.#retired;
		this.#retired = false;
		this.publish(this.#n, [["r", this.#n]], retired, context);
	}
}
function owner() {
	const abort = new AbortController(),
		errors: HostError[] = [],
		pending = new Set<Promise<unknown>>();
	const host = {
		spanHost: "client",
		report(error: HostError) {
			errors.push(error);
		},
		async acquire() {
			throw new Error("No dependencies");
		},
	};
	const value: RoutineOwner = {
		type: "app",
		label: "app",
		host,
		caller: { principal: { kind: "owner" }, incarnation: "app" },
		context: withAbortSignal(abort.signal, context),
		admit(work, cleanup) {
			pending.add(work);
			work.then(
				() => {
					pending.delete(work);
					cleanup();
				},
				() => {
					pending.delete(work);
					cleanup();
				},
			);
		},
	};
	return {
		value,
		errors,
		async close() {
			abort.abort();
			await Promise.allSettled(pending);
		},
	};
}
const flushed = async (): Promise<void> => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};

it("folds changes arriving during a routine and delivers the newest value with its retirement", async () => {
	vi.useFakeTimers();
	const app = owner(),
		batch = new Batch(() => {}, undefined),
		values = new Values(batch),
		routines = new Routines();
	const declarations = routines as RoutineDeclarations,
		gate = Promise.withResolvers<void>(),
		seen: unknown[] = [];
	let concurrent = 0,
		peak = 0;
	declarations.on(values, async (call) => {
		concurrent++;
		peak = Math.max(peak, concurrent);
		seen.push(call);
		if (call.value === 0) await gate.promise;
		concurrent--;
	});
	try {
		routines.start(app.value);
		await flushed();
		values.set(1, true);
		values.set(2);
		await flushed();
		expect(seen).toEqual([{ kind: "value", value: 0, ops: [["r", 0]], retired: false }]);
		gate.resolve();
		await flushed();
		await vi.advanceTimersByTimeAsync(0);
		expect(seen).toEqual([
			{ kind: "value", value: 0, ops: [["r", 0]], retired: false },
			{ kind: "value", value: 2, ops: [["r", 2]], retired: true },
		]);
		expect(peak).toBe(1);
		expect(app.errors).toEqual([]);
	} finally {
		gate.resolve();
		await app.close();
		vi.useRealTimers();
	}
});
it("retries a failed routine with a full value and wakes it early on a source change", async () => {
	vi.useFakeTimers();
	const app = owner(),
		batch = new Batch(() => {}, undefined),
		values = new Values(batch),
		routines = new Routines(),
		seen: unknown[] = [];
	const declarations = routines as RoutineDeclarations;
	declarations.on(values, (call) => {
		seen.push(call);
		if (call.value === 0) throw new Error("retry");
	});
	try {
		routines.start(app.value);
		await flushed();
		expect(app.errors).toHaveLength(1);
		values.set(1);
		await flushed();
		expect(seen).toEqual([
			{ kind: "value", value: 0, ops: [["r", 0]], retired: false },
			{ kind: "value", value: 1, ops: [["r", 1]], retired: false },
		]);
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		await app.close();
		vi.useRealTimers();
	}
});
it("backs off an onLive failure and stops after its successful invocation", async () => {
	vi.useFakeTimers();
	const app = owner(),
		routines = new Routines();
	let calls = 0;
	routines.onLive(() => {
		if (++calls === 1) throw new Error("retry");
	});
	try {
		routines.start(app.value);
		await flushed();
		expect(calls).toBe(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(calls).toBe(2);
		await vi.advanceTimersByTimeAsync(5000);
		expect(calls).toBe(2);
		expect(app.errors).toHaveLength(1);
	} finally {
		await app.close();
		vi.useRealTimers();
	}
});
