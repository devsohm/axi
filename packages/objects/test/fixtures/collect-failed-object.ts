import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import {
	broken,
	createHost,
	defineFacet,
	defineRegistry,
	int,
	local,
	ObjectsError,
	type HostError,
} from "../../src/index.ts";
import { ObjectsObject } from "../../src/host/object.ts";
const weak: WeakRef<ObjectsObject>[] = [],
	original = ObjectsObject.prototype.attempt;
ObjectsObject.prototype.attempt = function () {
	if (this.label === "sample.temporary(1)") weak.push(new WeakRef(this));
	return original.call(this);
};
const registry = defineRegistry<number, number>("sample.models", { version: 1 });
const temporary = local("sample.temporary", { version: 1, params: { id: int() }, members: {} });
const reports: HostError[] = [],
	host = createHost({ onError: (error) => reports.push(error) });
await host.load(
	[
		{
			name: "sample",
			facet: defineFacet((h) => {
				h.serve(registry, { compose: () => 0 });
				h.serve(temporary, (_, self) => {
					const value = self.registry(registry);
					self.retryOn(value);
					self.open(
						async () => {
							assert.equal(value.value, 0);
							throw broken(new ObjectsError({ code: "unavailable", message: "retry later" }));
						},
						() => {},
					);
					return {};
				});
			}),
		},
	],
	context,
);
await (async () => {
	const reference = host.hold(temporary, { id: 1 }, context);
	await setImmediate();
	reference.release();
	await setImmediate();
})();
for (let i = 0; i < 12; i++) {
	await setImmediate();
	globalThis.gc!();
}
assert.ok(weak.length > 0);
assert.ok(weak.every((reference) => reference.deref() === undefined));
assert.equal(reports.length, 1);
assert.equal(reports[0]?.kind, "activation_failed");
assert.equal((await host.registry(registry, context)).value, 0);
await host.close(context);
