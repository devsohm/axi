import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { RegistryContribution, type ContributionContent } from "../src/next/registries/contribution.ts";
import { RegistryRecord, type RegistryError } from "../src/next/registries/record.ts";
import { Batch, WritableSource } from "../src/next/state/internal.ts";
import { createHost, defineFacet, defineRegistry, local, type HostError } from "../src/next/index.ts";

function setup() {
	const errors: RegistryError[] = [];
	const batch = new Batch(() => {}, undefined);
	const registry = new RegistryRecord("app.values", batch, (error) => errors.push(error));
	const add = (plugin: string, content: ContributionContent, version = 1, type?: string) => {
		const contribution = new RegistryContribution(registry, { plugin, type }, version, content);
		batch.commit(() => registry.add(contribution), context);
		return contribution;
	};
	return { registry, batch, errors, add, owner: { context, assertUsable() {} } };
}

describe("experimental registries", () => {
	it("recomputes a contribution when its provider changes the adapter", () => {
		const { registry } = setup();
		const contribution = new RegistryContribution(registry, { plugin: "old", type: undefined }, 1,
			{ kind: "plain", value: 5 });
		const twice = { compose: () => 0, accepts: { 1: { contribution: (old: never) => Number(old) * 2 } } };
		const triple = { compose: () => 0, accepts: { 1: { contribution: (old: never) => Number(old) * 3 } } };
		expect(contribution.entry(2, twice)?.value).toBe(10);
		expect(contribution.entry(2, triple)?.value).toBe(15);
	});
	it("retries retained reader mappings when the adapter changes, including after a failure", () => {
		const { registry } = setup();
		const provider = { compose: () => 7, accepts: { 1: { value: (value: unknown) => Number(value) } } };
		registry.serve(2, provider);
		const value = registry.value(1), release = value.read();
		try {
			expect(value.value).toBe(7);
			provider.accepts[1].value = (raw) => Number(raw) + 1;
			expect(value.value).toBe(8);
			provider.accepts[1].value = () => { throw new Error("mapping stopped"); };
			expect(() => value.current()).toThrow("mapping stopped");
			expect(value.value).toBe(8);
			provider.accepts[1].value = (raw) => Number(raw) + 2;
			expect(value.current()).toBe(9);
		} finally { release(); }
	});
	it("sorts contributors and composes lazily once per changed table", () => {
		const { registry, batch, add } = setup();
		let composed = 0;
		registry.serve(1, { compose(table) { composed++; return table.map((entry) => `${entry.plugin}:${entry.type ?? ""}:${entry.value}`) } });
		add("z", { kind: "plain", value: 3 });
		add("a", { kind: "plain", value: 2 }, 1, "child");
		add("a", { kind: "plain", value: 1 });
		expect(composed).toBe(0);
		const value = registry.value(1);
		expect(value.value).toEqual(["a::1", "a:child:2", "z::3"]);
		expect(value.value).toEqual(["a::1", "a:child:2", "z::3"]);
		batch.commit(() => registry.contributionChanged(), context);
		void value.value;
		expect(composed).toBe(1);
	});
	it("adapts each older contribution once per identity and reports incompatible versions once", () => {
		const { registry, batch, errors, add, owner } = setup();
		const writable = new WritableSource(3, owner, batch);
		let adapted = 0;
		registry.serve(2, { compose: (table) => table.map((entry) => entry.value), accepts: {
			1: { contribution: (old: number) => { adapted++; return old * 2 } },
		} });
		add("old", { kind: "native", source: writable });
		add("new", { kind: "plain", value: 0 }, 3);
		const value = registry.value(2);
		expect(value.value).toEqual([6]);
		batch.commit(() => registry.contributionChanged(), context);
		expect(value.value).toEqual([6]);
		expect(adapted).toBe(1);
		writable.set(4);
		expect(value.value).toEqual([8]);
		expect(adapted).toBe(2);
		expect(errors).toEqual([{ kind: "contribution_refused", registry: "app.values", plugin: "new", version: 3 }]);
	});
	it("recomposes synchronously for observers and keeps the last good value through a compose failure", () => {
		const { registry, batch, errors, add, owner } = setup();
		const source = new WritableSource(1, owner, batch);
		registry.serve(1, { compose(table) {
			const sum = table.reduce((sum, entry) => sum + Number(entry.value), 0);
			if (sum < 0) throw new Error("negative");
			return sum;
		} });
		add("source", { kind: "native", source });
		const value = registry.value(1);
		const calls: unknown[] = [];
		const observation = value.observe({ advance(call) { calls.push(call) }, end() {} }, context);
		expect(observation.value).toBe(1);
		source.set(-1);
		expect(calls).toMatchObject([{ kind: "failed", error: { message: "negative" } }]);
		expect(value.value).toBe(1);
		expect(() => value.current()).toThrow("negative");
		source.set(-2);
		expect(errors).toHaveLength(1);
		source.set(2);
		expect(calls.at(-1)).toEqual({ kind: "value", value: 2 });
		observation.detach();
	});
	it("drops stale native values when a contributor leaves and the next composition fails", () => {
		const { registry, batch, add } = setup();
		registry.serve(1, { compose(table) { if (!table.length) throw new Error("empty"); return table[0]!.value } });
		const contribution = add("one", { kind: "plain", value: { native: "open" } });
		const value = registry.value(1);
		expect(value.value).toEqual({ native: "open" });
		batch.commit(() => registry.remove(contribution), context);
		expect(() => value.value).toThrow("empty");
	});
	it("maps older readers once per composition while retained and rejects unmapped versions", () => {
		const { registry, batch, add, owner } = setup();
		const source = new WritableSource(4, owner, batch);
		let mapped = 0;
		registry.serve(2, { compose: (table) => Number(table[0]?.value ?? 0), accepts: {
			1: { value: (current) => { mapped++; return { old: Number(current) } } },
		} });
		add("source", { kind: "native", source }, 2);
		const old = registry.value(1);
		const release = old.read();
		expect(old.value).toEqual({ old: 4 });
		expect(old.value).toEqual({ old: 4 });
		source.set(5);
		expect(old.value).toEqual({ old: 5 });
		expect(mapped).toBe(2);
		expect(() => registry.value(3).value).toThrow(expect.objectContaining({ code: "contract_mismatch" }));
		release();
		void old.value;
		expect(mapped).toBe(3);
	});
	it("wakes waiters when a missing provider becomes usable and ends their wait on close", () => {
		const { registry, batch } = setup();
		const value = registry.value(1);
		const calls: unknown[] = [];
		value.wait({ dependencyMoved() { calls.push("moved") }, closed(error) { calls.push(error.code) } });
		expect(() => value.value).toThrow(expect.objectContaining({ code: "unavailable", reason: "undeclared" }));
		registry.serve(1, { compose: () => 10 });
		batch.commit(() => registry.composeServed(), context);
		expect(calls).toEqual(["moved"]);
		expect(value.value).toBe(10);
		registry.close();
		expect(calls).toEqual(["moved", "released"]);
		expect(value.value).toBe(10);
	});
	it("keeps an object live when its registry contributions form a cycle", async () => {
		const first = defineRegistry<number, number>("app.first", { version: 1 });
		const second = defineRegistry<number, number>("app.second", { version: 1 });
		const owner = local("app.contributor", { version: 1, params: {}, members: {} });
		const errors: HostError[] = [];
		const host = createHost({ onError: (error) => errors.push(error), readyTimeout: 100 });
		try {
			await host.load([{ name: "registrations", facet: defineFacet((h) => {
				h.serve(first, { compose: (table) => table.length });
				h.serve(second, { compose: (table) => table.length });
				h.serve(owner, (_, self) => {
					self.contribute(first, self.registry(second));
					self.contribute(second, self.registry(first));
					return {};
				});
			}) }], context);
			expect((await host.get(owner, {}, context)).state.value).toEqual({ kind: "live" });
			expect([(await host.registry(first, context)).value, (await host.registry(second, context)).value]).toEqual([1, 0]);
			expect(errors).toMatchObject([{ kind: "contribution_failed", registry: "app.second",
				type: "app.contributor", error: { code: "invalid", reason: "cycle" } }]);
		} finally {
			await host.close(context);
		}
	});
	it("reports a conflict once per episode and maps an undefined composition", () => {
		const { registry, batch, errors, add, owner } = setup();
		const source = new WritableSource(1, owner, batch);
		registry.serve(2, { compose(table, context) {
			if (Number(table[0]?.value ?? 0) > 0) context.report({ message: "duplicate", plugins: ["a", "b"] });
			return undefined;
		}, accepts: { 1: { value: () => "empty" } } });
		add("source", { kind: "native", source }, 2);
		const value = registry.value(2);
		void value.value;
		source.set(2);
		void value.value;
		expect(errors).toHaveLength(1);
		source.set(0);
		void value.value;
		source.set(1);
		void value.value;
		expect(errors).toHaveLength(2);
		expect(registry.value(1).value).toBe("empty");
	});
});
