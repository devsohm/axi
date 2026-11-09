import { afterEach, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, awaitWithContext } from "../src/context/index.ts";
import {
	createHost,
	defineFacet,
	defineJob,
	defineState,
	int,
	local,
	method,
	obj,
	openStore,
	sqliteBackend,
	str,
	unknown as jsonValue,
} from "../src/index.ts";
import { Persistence } from "../src/documents/internal.ts";
import { ObjectsStore } from "../src/store/store.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";

afterEach(() => vi.useRealTimers());
const progress = defineState("timed-progress", {
	version: 1,
	schema: obj({ n: int() }),
	initial: () => ({ n: 0 }),
	persist: true,
	checkpointWhen: () => false,
});
const Work = defineJob("timed-work", {
	version: 1,
	args: obj({ n: int(), delay: int() }),
	result: int(),
	state: progress,
	concurrency: 2,
	persist: { resume: "rerun" },
});
const Runner = local("timed.runner", {
	version: 1,
	params: {},
	members: { start: method(obj({ n: int(), delay: int() }), str()), jobs: jsonValue() },
});

async function fixture(expected: number) {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	if (!(store instanceof ObjectsStore)) throw new Error("The fixture requires the SQLite Store");
	const errors: unknown[] = [];
	const host = createHost({ store, onError: (error) => errors.push(error) });
	const release = Promise.withResolvers<void>(),
		updated = Promise.withResolvers<void>();
	let changes = 0;
	try {
		await host.load(
			[
				{
					name: "runner",
					facet: defineFacet((h) =>
						h.serve(Runner, (_params, self) => {
							const work = self.job(Work, {
								async run({ n, delay }, ctx) {
									await ctx.state.change(
										(state) => {
											state.n = n;
										},
										ctx,
										{ persistence: { kind: "deferred", withinMs: delay } },
									);
									if (++changes === expected) updated.resolve();
									await awaitWithContext(release.promise, ctx);
									return n;
								},
							});
							return { start: async (args, ctx) => (await work.start(args, ctx)).id, jobs: work.running };
						}),
					),
				},
			],
			context,
		);
		const ref = await host.get(Runner, {}, context);
		const saved = new Persistence(store, Runner.name, "objects.job-states", Work.name);
		return {
			host,
			store,
			ref,
			saved,
			updated,
			errors,
			async [Symbol.asyncDispose]() {
				release.resolve();
				ref.release();
				await host.close(context);
				await store.close(context);
			},
		};
	} catch (error) {
		release.resolve();
		await host.close(context);
		await store.close(context);
		throw error;
	}
}

test.each([
	[20, 80],
	[80, 20],
] satisfies [number, number][])(
	"the host persists job state at each deadline in order %s, %s",
	async (firstDelay, secondDelay) => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		await using app = await fixture(2);
		const first = await app.ref.start({ n: 7, delay: firstDelay }, context);
		const second = await app.ref.start({ n: 9, delay: secondDelay }, context);
		await app.updated.promise;
		expect(app.ref.jobs.value).toMatchObject([
			{ id: first, state: { n: 7 }, phase: "running" },
			{ id: second, state: { n: 9 }, phase: "running" },
		]);
		for (const id of [first, second]) expect((await app.saved.read(id, context))?.value).toEqual({ n: 0 });
		await vi.advanceTimersByTimeAsync(19);
		for (const id of [first, second]) expect((await app.saved.read(id, context))?.value).toEqual({ n: 0 });
		await vi.advanceTimersByTimeAsync(1);
		expect((await app.saved.read(first, context))?.value).toEqual({ n: firstDelay === 20 ? 7 : 0 });
		expect((await app.saved.read(second, context))?.value).toEqual({ n: secondDelay === 20 ? 9 : 0 });
		await vi.advanceTimersByTimeAsync(60);
		expect((await app.saved.read(first, context))?.value).toEqual({ n: 7 });
		expect((await app.saved.read(second, context))?.value).toEqual({ n: 9 });
		expect(app.errors).toEqual([]);
	},
);

test("closing the host flushes held state before its deadline without retiring the saved job", async () => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	await using app = await fixture(1);
	const id = await app.ref.start({ n: 11, delay: 60000 }, context);
	await app.updated.promise;
	expect((await app.saved.read(id, context))?.value).toEqual({ n: 0 });
	await app.host.close(context);
	expect((await app.saved.read(id, context))?.value).toEqual({ n: 11 });
	const run = await new Persistence(app.store, Runner.name, "objects.jobs", Work.name).read(id, context);
	expect(run).toBeDefined();
	expect(app.errors).toEqual([]);
});
