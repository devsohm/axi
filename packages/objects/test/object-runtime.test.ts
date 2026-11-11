import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { int, local, method, obj, type Contract } from "../src/contracts/index.ts";
import { ObjectsError } from "../src/data/index.ts";
import { bindProvider } from "../src/data/internal.ts";
import { defineState } from "../src/documents/index.ts";
import { Attempt, type Self } from "../src/host/attempt.ts";
import { Backoff } from "../src/host/backoff.ts";
import { ObjectsObject, type ObjectHost, type Served } from "../src/host/object.ts";
import { Binding, type Reference } from "../src/host/reference.ts";
import type { HostError } from "../src/host/report.ts";
import { OldWork } from "../src/host/old-work.ts";
import { HostDataGate } from "../src/host/host-data.ts";
import { ReloadCycles } from "../src/host/reload-cycle.ts";
import { RegistryRecord } from "../src/registries/internal.ts";
import { Batch } from "../src/state/internal.ts";
const counter = defineState("counter", { version: 1, schema: obj({ n: int() }), initial: () => ({ n: 0 }) });
const type = local("app.item", {
	version: 1,
	params: { id: int() },
	members: { counter: obj({ n: int() }), add: method(obj({ by: int() }), int()) },
});
const caller = { principal: { kind: "owner" }, incarnation: "host" };

function fixture(factory: (self: Self) => unknown, linger = 0) {
	const errors: HostError[] = [],
		counts: [string, number][] = [],
		endings = new Map<string, Promise<void>>(),
		registries = new Map<string, RegistryRecord>();
	let object: ObjectsObject,
		forgotten = 0;
	const batch = new Batch((error) => errors.push(error), undefined),
		backoff = new Backoff(() => object.attempt());
	const host: ObjectHost = {
		hostData: new HostDataGate(),
		spanHost: "client",
		batch,
		backoff,
		oldWork: new OldWork(),
		reloadCycles: new ReloadCycles(),
		waitAsOldWork: (waiting) => waiting,
		principal: caller.principal,
		incarnation: caller.incarnation,
		timeouts: { close: 100, ready: 1000, reload: 100 },
		store: undefined,
		report(error) {
			errors.push(error);
		},
		count(kind, delta) {
			counts.push([kind, delta]);
		},
		referenced() {},
		unreferenced() {},
		wentLive() {},
		forget() {
			forgotten++;
			backoff.ended("item");
		},
		endingOf(id) {
			return endings.get(id);
		},
		ending(id, work) {
			const previous = endings.get(id),
				joined = previous ? Promise.all([previous, work]).then(() => {}) : work;
			endings.set(id, joined);
			void joined.then(() => {
				if (endings.get(id) === joined) endings.delete(id);
			});
		},
		cycle() {
			return new ObjectsError({ code: "invalid", reason: "cycle", message: "cycle" });
		},
		reference(contract, dependent, caller, options) {
			return new Binding(contract, batch, dependent, caller, options.readyTimeout ?? 1000);
		},
		bind() {
			throw new Error("No dependencies declared");
		},
		async acquire() {
			throw new Error("No dependencies declared");
		},
		registryRecord(name) {
			let record = registries.get(name);
			if (!record) {
				record = new RegistryRecord(name, batch, (error) => errors.push(error));
				registries.set(name, record);
			}
			return record;
		},
	};
	const served: Served = {
		kind: "local",
		contract: type,
		provider: bindProvider(type, {}),
		plugin: "app",
		hostLifetime: false,
		linger,
		factory: (_params, self) => factory(self),
	};
	object = new ObjectsObject(host, served, { id: 1 }, undefined, "1", "item", context, []);
	function reference<C extends Contract>(contract: C) {
		const binding = new Binding(contract, batch, undefined, caller, 1000);
		binding.bind(object);
		return { binding, value: binding.reference as Reference<C> };
	}
	return {
		object,
		errors,
		counts,
		reference,
		forgotten: () => forgotten,
		async close() {
			backoff.clear();
			const stop = object.stop();
			await Promise.all(endings.values());
			const failures = await stop();
			return failures;
		},
	};
}

it("keeps committed state across a failed attempt and rebinds existing references after retry", async () => {
	let current: Attempt | undefined,
		opens = 0,
		closes = 0;
	const app = fixture((self) => {
		if (self instanceof Attempt) current = self;
		const count = self.state(counter),
			native = self.open(
				async () => ++opens,
				() => {
					closes++;
				},
			);
		return {
			counter: count,
			add: ({ by }: { by: number }) =>
				self.tx(async (tx) => {
					void native.value;
					const value = await tx.draft(count);
					value.n += by;
					return value.n;
				}, context),
		};
	});
	const { binding, value: ref } = app.reference(type);
	try {
		app.object.attempt();
		await binding.live(context);
		expect(await ref.add({ by: 2 }, context)).toBe(2);
		const failure = new ObjectsError({ code: "unavailable", message: "retry me" });
		const attempt = current;
		if (!attempt) throw new Error("No attempt");
		app.object.failLive(attempt, { kind: "broken", error: failure });
		expect(ref.counter.value).toEqual({ n: 2 });
		await expect(ref.add({ by: 1 }, context)).rejects.toBe(failure);
		ref.retry();
		await binding.live(context);
		expect(await ref.add({ by: 1 }, context)).toBe(3);
		expect([opens, closes]).toEqual([2, 1]);
		expect(app.errors).toEqual([
			{ kind: "object_failed", object: "app.item(1)", failure: { kind: "broken", error: failure } },
		]);
	} finally {
		ref.release();
		expect(await app.close()).toEqual([]);
	}
	expect(closes).toBe(2);
	expect(app.forgotten()).toBe(1);
});

it("reuses an object during its linger interval and ends it after the final release", async () => {
	vi.useFakeTimers();
	const app = fixture((self) => ({ counter: self.state(counter), add: async () => 0 }), 20);
	try {
		const first = app.reference(type);
		app.object.attempt();
		await first.binding.live(context);
		first.value.release();
		await vi.advanceTimersByTimeAsync(10);
		const second = app.reference(type);
		await second.binding.live(context);
		await vi.advanceTimersByTimeAsync(20);
		expect(app.forgotten()).toBe(0);
		second.value.release();
		await vi.advanceTimersByTimeAsync(20);
		expect(app.forgotten()).toBe(1);
		expect(app.object.state.kind).toBe("ended");
		expect(app.counts.filter(([kind]) => kind === "lingering")).toEqual([
			["lingering", 1],
			["lingering", -1],
			["lingering", 1],
			["lingering", -1],
		]);
	} finally {
		await app.close();
		vi.useRealTimers();
	}
});
