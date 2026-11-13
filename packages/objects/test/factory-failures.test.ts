import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import {
	constant,
	createHost,
	defineFacet,
	defineJob,
	defineRegistry,
	defineState,
	defineTable,
	int,
	local,
	obj,
	openStore,
	sqliteBackend,
	type StoreSelf,
} from "../src/index.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";

const Value = local("checked.factory", { version: 1, params: {}, members: { value: int() } });
const State = defineState("checked-state", {
	version: 1,
	schema: obj({ value: int() }),
	initial: () => ({ value: 0 }),
});
const Saved = defineState("checked-saved-state", {
	version: 1,
	schema: obj({ value: int() }),
	initial: () => ({ value: 0 }),
	persist: true,
	checkpointWhen: () => false,
});
const Rows = defineTable("checked-rows", { version: 1, columns: { id: int() }, key: ["id"] });
const Work = defineJob("checked-work", { version: 1, args: int(), result: int() });
const SavedWork = defineJob("checked-saved-work", {
	version: 1,
	args: int(),
	result: int(),
	persist: { resume: "rerun" },
});
const Contributions = defineRegistry<number, number>("checked-values", { version: 1 });

const failures = [
	{
		name: "duplicate state",
		store: true,
		message: 'state "checked-state" is declared twice',
		declare(self: StoreSelf) {
			self.state(State);
			self.state(State);
		},
	},
	{
		name: "duplicate table",
		store: true,
		message: 'table "checked-rows" is declared twice',
		declare(self: StoreSelf) {
			self.table(Rows);
			self.table(Rows);
		},
	},
	{
		name: "duplicate job",
		store: true,
		message: 'job "checked-work" is declared twice',
		declare(self: StoreSelf) {
			self.job(Work, { run: async (n) => n });
			self.job(Work, { run: async (n) => n });
		},
	},
	{
		name: "duplicate contribution",
		store: true,
		message: "contributed to twice",
		declare(self: StoreSelf) {
			self.contribute(Contributions, 1);
			self.contribute(Contributions, 2);
		},
	},
	{
		name: "saved state without a Store",
		store: false,
		message: "persist needs a store",
		declare(self: StoreSelf) {
			self.state(Saved);
		},
	},
	{
		name: "table without a Store",
		store: false,
		message: "persist needs a store",
		declare(self: StoreSelf) {
			self.table(Rows);
		},
	},
	{
		name: "saved job without a Store",
		store: false,
		message: "persist needs a store",
		declare(self: StoreSelf) {
			self.job(SavedWork, { run: async (n) => n });
		},
	},
];

test.each(failures)("$name fails activation and permits a corrected factory reload", async ({ declare, store: needsStore, message }) => {
	const store = needsStore
		? await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)
		: undefined;
	const host = createHost({ store, onError() {} });
	try {
		await host.load(
			[
				{
					name: "checked",
					facet: defineFacet((h) =>
						h.serve(Value, (_params, self: StoreSelf) => {
							declare(self);
							return { value: constant(1) };
						}),
					),
				},
			],
			context,
		);
		const ref = host.hold(Value, {}, context);
		try {
			await vi.waitFor(() =>
				expect(ref.state.value).toMatchObject({
					kind: "failed",
					cause: { error: { message: expect.stringContaining(message) } },
				}),
			);
			const reload = await host.reload(
				[{ name: "checked", facet: defineFacet((h) => h.serve(Value, () => ({ value: constant(7) }))) }],
				context,
			);
			expect(reload.failed).toEqual([]);
			await vi.waitFor(() => expect(ref.state.value.kind).toBe("live"));
			expect(ref.value.value).toBe(7);
		} finally {
			ref.release();
		}
	} finally {
		await host.close(context);
		await store?.close(context);
	}
});

test.each(failures)(
	"$name rejects a replacement before changing its live provider",
	async ({ declare, store: needsStore, message }) => {
		const store = needsStore
			? await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)
			: undefined;
		const host = createHost({ store, onError() {} });
		const valid = (value: number) => ({
			name: "checked",
			facet: defineFacet((facet) => facet.serve(Value, () => ({ value: constant(value) }))),
		});
		try {
			await host.load([valid(1)], context);
			const ref = await host.get(Value, {}, context);
			try {
				const reload = await host.reload(
					[
						{
							name: "checked",
							facet: defineFacet((facet) =>
								facet.serve(Value, (_params, self: StoreSelf) => {
									declare(self);
									return { value: constant(99) };
								}),
							),
						},
					],
					context,
				);
				expect(reload.failed).toMatchObject([
					{ plugin: "checked", error: { message: expect.stringContaining(message) } },
				]);
				expect(ref.state.value.kind).toBe("live");
				expect(ref.value.value).toBe(1);
				expect((await host.reload([valid(7)], context)).failed).toEqual([]);
				await vi.waitFor(() => expect(ref.value.value).toBe(7));
			} finally {
				ref.release();
			}
		} finally {
			await host.close(context);
			await store?.close(context);
		}
	},
);
