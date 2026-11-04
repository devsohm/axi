# Build a counter that survives code reload

This program creates a counter, increments it, replaces its implementation and keeps the same document value.

Save this code as `counter.ts` in a Node project that can import the toolkit packages.

```ts
import {
	createHost, defineFacet, defineState, int, local, method, obj,
} from "@axi/objects";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";

const Count = defineState("counter.value", {
	version: 1,
	schema: obj({ count: int() }),
	initial: () => ({ count: 0 }),
});
const Counter = local("counter", {
	version: 1,
	params: {},
	members: { value: int(), increment: method() },
});
const implementation = (amount: number) => defineFacet((host) => {
	host.serve(Counter, (_params, self) => {
		const state = self.state(Count);
		return {
			value: self.derive([state], ([value]) => value.count),
			increment: async (ctx) => {
				await state.change((draft) => { draft.count += amount; }, ctx);
				return null;
			},
		};
	});
});

const host = createHost({ onError: (error) => console.error(error) });
try {
	await host.load([{ name: "counter", facet: implementation(1) }], context);
	const counter = await host.get(Counter, {}, context);
	await counter.increment(context);
	console.log(counter.value.value);
	await host.reload([{ name: "counter", facet: implementation(2) }], context);
	await counter.increment(context);
	console.log(counter.value.value);
	counter.release();
} finally {
	await host.close(context);
}
```

Run `node counter.ts`. The output is `1`, then `3`.

The document belongs to the object. Reload replaces the method and derivation while retaining that document. Add a Store and a persisted definition when the value must also survive a process restart. See the [guide](guide.md#documents-tables-and-jobs) for storage and the [specification](spec.md) for failure behavior.
