import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { track } from "../src/delta/index.ts";
import {
	defineState,
	int,
	obj,
	openStore,
	sqliteBackend,
} from "../src/next/index.ts";
import {
	Persistence,
	storedAfter,
	type Stored,
} from "../src/next/documents/persistence.ts";
import type { StagedWrite } from "../src/next/store/step.ts";
import { ObjectsStore } from "../src/next/store/store.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";

it("writes bases, deltas and replacement incarnations without publishing a staged draft", async () => {
	const store = await openStore(
		sqliteBackend(await openNodeSqliteDatabase(":memory:")),
		context,
		{ outbox: true },
	);
	if (!(store instanceof ObjectsStore))
		throw new Error("Unexpected Store implementation");
	const Counter = defineState("counter", {
		schema: obj({ n: int() }),
		version: 1,
		initial: () => ({ n: 0 }),
		persist: true,
		checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 1,
	});
	const persistence = new Persistence(store, "app", "state", "counter");
	let stored: Stored | undefined;
	try {
		for (const n of [1, 2, 3]) {
			const before = await persistence.read("a", context);
			const tracker = track(
				before === undefined
					? Counter.initial(context)
					: persistence.decode(before, Counter, context).value,
			);
			const edit = tracker.beginChange();
			edit.state.n = n;
			const writes: StagedWrite[] = [];
			const change = persistence.stage(
				"a",
				Counter,
				stored,
				{ prepared: edit.prepare(), retires: false },
				writes,
			);
			expect((await persistence.read("a", context))?.value).toEqual(
				n === 1 ? undefined : { n: n - 1 },
			);
			await store.commit(
				writes,
				{ admit: () => true, adopt: () => {} },
				context,
			);
			stored = storedAfter(change);
		}
		expect((await persistence.read("a", context))?.value).toEqual({ n: 3 });
		expect(stored).toMatchObject({ revision: 3, deltasSinceBase: 0 });
		const writes: StagedWrite[] = [];
		persistence.stage(
			"a",
			Counter,
			stored,
			{ prepared: undefined, retires: true },
			writes,
		);
		await store.commit(writes, { admit: () => true, adopt: () => {} }, context);
		expect(await persistence.find("a", context)).toBeUndefined();
		expect(
			(await store.outbox!.read(0, 10, context)).map((commit) =>
				commit.writes.map((write) =>
					write.kind === "document.change" ? write.content.kind : write.kind,
				),
			),
		).toEqual([["document.create"], ["delta"], ["base"], ["document.retire"]]);
	} finally {
		await store.close(context);
	}
});
