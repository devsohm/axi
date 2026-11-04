import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal, type Context } from "../src/context/index.ts";
import { Routines, type RoutineDeclarations, type RoutineOwner } from "../src/host/routines.ts";
import type { HostError } from "../src/host/report.ts";
import { Batch, Source } from "../src/state/internal.ts";

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
