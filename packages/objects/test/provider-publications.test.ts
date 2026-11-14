import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { ObjectsError } from "../src/data/index.ts";
import type { Hold } from "../src/remote/hold.ts";
import type { HostLink } from "../src/remote/host-link.ts";
import { ProviderSide } from "../src/remote/provider.ts";
import { Batch } from "../src/state/internal.ts";

it.each([false, true])("drops state for a hold that unbinds before its batch flushes (window busy: %s)", (busy) => {
	const messages: unknown[] = [],
		errors: unknown[] = [];
	const batch = new Batch((error) => errors.push(error), undefined);
	const link = {
		context,
		host: { batch },
		send(message: unknown) {
			messages.push(message);
		},
	} as unknown as HostLink;
	const provider = new ProviderSide(link, 0, 256);
	let bound = true;
	const entry = { hold: 1, members: [], failed: [], retired: [] };
	const hold = {
		id: 1,
		kind: "served",
		get bound() {
			return bound;
		},
		entry: () => entry,
		pendingEntry: () => entry,
		queue() {},
		boundEntry: () => ({ hold: 1, variant: 0, members: [], failed: [] }),
	} as unknown as Hold;
	if (busy) {
		provider.bind(hold, context);
		provider.bind(hold, context);
		messages.length = 0;
	}
	batch.commit(() => {
		provider.touched(hold);
		bound = false;
		provider.unbound(hold, new ObjectsError({ code: "released", message: "left" }));
	}, context);
	if (busy) provider.message({ kind: "ack" });
	expect(messages).toEqual([]);
	expect(errors).toEqual([]);
});
