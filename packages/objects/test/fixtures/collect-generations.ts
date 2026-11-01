import assert from "node:assert/strict";
import { Type } from "typebox";
import { createHost, defineRegistry, type Facet, local, method } from "../../src/index.ts";

assert.equal(typeof globalThis.gc, "function");
const finalized = new Set<number>();
const registry = new FinalizationRegistry<number>((id) => finalized.add(id));
const commands = defineRegistry<() => number>("generations");
const counter = local("collectable", {
	version: 1,
	input: Type.Object({}),
	members: { value: Type.Number(), generation: method(undefined, Type.Number()) },
});
const closed: number[] = [];
function facet(id: number): Facet {
	const marker = { id };
	registry.register(marker, id);
	return {
		name: "counter",
		setup(api) {
			api.serve(
				counter,
				(_input, _principal, self) => {
					const value = self.state("value", Type.Number(), 0);
					self.resource("connection", {
						version: 1,
						open: () => null,
						close: () => {
							closed.push(marker.id);
						},
					});
					self.on("value", value, () => {
						assert(marker.id >= 0);
					});
					self.task(async (ctx) => {
						await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
						assert(marker.id >= 0);
					});
					self.register(commands, { current: () => marker.id });
					return {
						value,
						generation(ctx) {
							ctx.signal.addEventListener("abort", () => marker.id);
							return marker.id;
						},
					};
				},
				{ lifetime: "host" },
			);
		},
	};
}
const host = createHost({
	self: null,
	onError(error) {
		throw error;
	},
});
try {
	await host.install(facet(0));
	for (let id = 1; id <= 4; id++) {
		await host.reload([facet(id)]);
		assert.equal(await host.root(async (ctx) => (await ctx.get(counter, {})).generation(ctx)), id);
		assert.equal(host.registry(commands).get("current")?.(), id);
	}
	for (let attempt = 0; attempt < 100 && finalized.size < 4; attempt++) {
		globalThis.gc!();
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.deepEqual([...finalized].sort(), [0, 1, 2, 3]);
	assert.deepEqual(closed, []);
} finally {
	await host.close();
}
assert.deepEqual(closed, [4]);
