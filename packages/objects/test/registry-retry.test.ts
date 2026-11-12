import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, type Context } from "../src/context/index.ts";
import {
	bool,
	constant,
	createHost,
	defineFacet,
	defineRegistry,
	int,
	keyedEntries,
	local,
	method,
	orderedEntries,
	type RegistryTable,
	type RegistryValue,
} from "../src/index.ts";

test("registry declaration retains the version selected from its options", () => {
	let reads = 0;
	const registry = defineRegistry<number, number>("observed.version", {
		get version() { return ++reads; },
	});
	expect(registry.version).toBe(1);
	expect(reads).toBe(1);
});

test("registry observation retains the cancellation signal selected at attachment", async () => {
	const Total = defineRegistry<number, number>("observed.total", { version: 1 });
	const Consumer = local("observed.consumer", { version: 1, params: {}, members: {} });
	let observed: RegistryValue<number> | undefined;
	const host = createHost({ onError() {} });
	const facet = defineFacet((facet) => {
		facet.serve(Total, { compose: () => 1 });
		facet.serve(Consumer, (_params, self) => {
			observed = self.registry(Total);
			return {};
		});
	});
	await host.load([{ name: "observed", facet }], context);
	try {
		const held = await host.get(Consumer, {}, context);
		try {
			if (!observed) throw new Error("Registry was not attached");
			const first = new AbortController(),
				second = new AbortController();
			second.abort();
			let reads = 0;
			const invocation: Context = {
				get abortSignal() {
					return ++reads === 1 ? first.signal : second.signal;
				},
				telemetry: context.telemetry,
				value: (key) => context.value(key),
				toString: () => "observation",
			};
			const ends: unknown[] = [];
			const observation = observed.observe({
				advance() {},
				end(end) { ends.push(end); },
			}, invocation);
			try {
				expect(observation.value).toBe(1);
				first.abort();
				expect(ends).toEqual([{ kind: "aborted" }]);
				expect(reads).toBe(1);
			} finally {
				observation.detach();
			}
		} finally {
			held.release();
		}
	} finally {
		await host.close(context);
	}
});

test("an activation can retry on registry changes without restarting healthy objects", async () => {
	const Enabled = defineRegistry<boolean, boolean>("enabled", { version: 1 });
	const Control = local("control", { version: 1, params: {}, members: { enabled: bool(), set: method(bool()) } });
	const Service = local("service", { version: 1, params: {}, members: { value: int() } });
	let attempts = 0,
		closes = 0;
	const host = createHost({ onError() {} });
	const facet = defineFacet((facet) => {
		facet.serve(Enabled, { compose: (entries) => entries.some((entry) => entry.value) });
		facet.serve(Control, (_params, self) => {
			const enabled = self.writable(false);
			self.contribute(Enabled, enabled);
			return {
				enabled: self.derive([enabled], ([value]) => value),
				async set(value) {
					enabled.set(value);
					return null;
				},
			};
		});
		facet.serve(Service, (_params, self) => {
			const enabled = self.registry(Enabled);
			self.retryOn(enabled, constant("unchanging"));
			self.open(
				async () => {
					attempts++;
					if (!enabled.value) throw new Error("Service disabled");
					return null;
				},
				() => {
					closes++;
				},
			);
			return { value: constant(42) };
		});
	});
	await host.load([{ name: "services", facet }], context);
	try {
		const control = await host.get(Control, {}, context),
			service = host.hold(Service, {}, context);
		try {
			await vi.waitFor(() => expect(service.state.value.kind).toBe("failed"));
			expect(attempts).toBe(1);
			await control.set(true, context);
			await vi.waitFor(() => expect(service.state.value.kind).toBe("live"));
			expect(service.value.value).toBe(42);
			expect(attempts).toBe(2);
			await control.set(false, context);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(service.state.value.kind).toBe("live");
			expect(attempts).toBe(2);
		} finally {
			service.release();
			control.release();
		}
	} finally {
		await host.close(context);
	}
	expect(closes).toBe(1);
});

test("retry sources cannot retain writable state belonging to the failed activation", async () => {
	const host = createHost({ onError() {} });
	const Service = local("invalid.retry.source", { version: 1, params: {}, members: { value: int() } });
	try {
		const result = await host.load(
			[
				{
					name: "invalid-source",
					facet: defineFacet((facet) =>
						facet.serve(Service, (_params, self) => {
							self.retryOn(self.writable(1));
							return { value: constant(1) };
						}),
					),
				},
			],
			context,
		);
		expect(result.failed).toEqual([]);
		await expect(host.get(Service, {}, context)).rejects.toThrow(/sources that outlive the attempt/);
	} finally {
		await host.close(context);
	}
});

test("registry entry helpers preserve contributor ownership, stable order and first-writer conflict reports", () => {
	const reports = vi.fn();
	const table: RegistryTable<{ entries?: Record<string, number> }> = [
		{ plugin: "first", version: 1, type: "provider", value: { entries: { a: 2, b: 1 } } },
		{ plugin: "absent", version: 1, value: {} },
		{ plugin: "second", version: 1, value: { entries: { a: 99, c: 3 } } },
	];
	expect([...keyedEntries(table, (row) => row.entries, reports)]).toEqual([
		["a", { value: 2, plugin: "first", type: "provider" }],
		["b", { value: 1, plugin: "first", type: "provider" }],
		["c", { value: 3, plugin: "second" }],
	]);
	expect(reports).toHaveBeenCalledWith({ message: '"a" is contributed twice', plugins: ["first", "second"] });
	const lists: RegistryTable<readonly { n: number }[] | undefined> = [
		{ plugin: "first", version: 1, value: [{ n: 3 }, { n: 1 }] },
		{ plugin: "absent", version: 1, value: undefined },
		{ plugin: "second", version: 1, type: "provider", value: [{ n: 1 }, { n: 2 }] },
	];
	expect(orderedEntries(lists, (row) => row).map((row) => row.value.n)).toEqual([3, 1, 1, 2]);
	expect(
		orderedEntries(
			lists,
			(row) => row,
			(row) => row.n,
		).map((row) => [row.plugin, row.value.n]),
	).toEqual([
		["first", 1],
		["second", 1],
		["second", 2],
		["first", 3],
	]);
});
