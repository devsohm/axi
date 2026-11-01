import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { defineState, int, obj, openStore, sqliteBackend } from "../src/next/index.ts";
import { Documents, Persistence } from "../src/next/documents/internal.ts";
import { RunStates } from "../src/next/jobs/run-states.ts";
import { Batch } from "../src/next/state/internal.ts";
import type { StagedWrite } from "../src/next/store/step.ts";
import { ObjectsStore } from "../src/next/store/store.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";

it.each([
	{ checkpoint: false, reloaded: false },
	{ checkpoint: true, reloaded: false },
	{ checkpoint: false, reloaded: true },
	{ checkpoint: true, reloaded: true },
])(
	"flushes deferred job state with its own definition, checkpoint=$checkpoint, reloaded=$reloaded",
	async ({ checkpoint, reloaded }) => {
		const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context, { outbox: true });
		if (!(store instanceof ObjectsStore)) throw new Error("Unexpected Store implementation");
		const documents = new Documents({
			label: "app",
			batch: new Batch(() => {}, undefined),
			context,
			store: { store, owner: "app" },
			fail(error) {
				throw error;
			},
		});
		const checks: number[] = [],
			published: unknown[] = [],
			deadlines: number[] = [];
		const definition = defineState("progress", {
			schema: obj({ n: int() }),
			version: 1,
			persist: true,
			initial: () => ({ n: 0 }),
			checkpointWhen: (_value, _ops, info) => {
				checks.push(info.deltasSinceBase);
				return checkpoint;
			},
		});
		const disk = new Persistence(store, "app", "job-state", "job"),
			states = new RunStates(
				definition,
				{
					documents,
					changed(id) {
						published.push(states.value(id));
					},
					held(deadline) {
						deadlines.push(deadline);
					},
				},
				disk,
			);
		try {
			const writes: StagedWrite[] = [],
				adopt = states.stageCreate("one", { n: 0 }, () => writes);
			await store.commit(writes, { admit: () => true, adopt }, context);
			const createdSeq = store.lastSeq;
			for (const n of [1, 2]) {
				if (reloaded && n === 2)
					states.redefine(
						defineState("progress", {
							schema: obj({ n: int() }),
							version: 2,
							persist: true,
							initial: () => ({ n: 0 }),
							migrate: (old) => ({ n: Number(old.n) + 100 }),
							checkpointWhen: () => !checkpoint,
						}),
					);
				await documents.tx(
					async (tx) => {
						(await tx.draftSlot(states, "one")).n = n;
					},
					documents.own,
					context,
					{ kind: "deferred", withinMs: 100 },
				);
			}
			expect(store.lastSeq).toBe(createdSeq);
			expect([states.value("one"), (await disk.read("one", context))?.value]).toEqual([{ n: 2 }, { n: 0 }]);
			expect(published).toEqual([{ n: 1 }, { n: 2 }]);
			expect(checks).toEqual(checkpoint ? [0, 0] : [0, 1]);
			expect(deadlines.length).toBe(2);
			expect(states.heldIds).toEqual(["one"]);
			const flush: StagedWrite[] = [],
				flushed = states.stageHeld("one", flush);
			await store.commit(flush, { admit: () => true, adopt: () => flushed?.() }, context);
			expect((await disk.read("one", context))?.value).toEqual({ n: 2 });
			expect((await disk.read("one", context))?.record.version).toBe(1);
			expect(states.migrated("one", context)).toEqual({ n: reloaded ? 102 : 2 });
			expect(states.heldIds).toEqual([]);
			const last = (await store.outbox!.read(0, 10, context)).at(-1)!.writes;
			expect(last.map((write) => (write.kind === "document.change" ? write.content.kind : write.kind))).toEqual([
				checkpoint ? "base" : "delta",
			]);
		} finally {
			documents.seal();
			await documents.settled();
			documents.end();
			await store.close(context);
		}
	},
);
