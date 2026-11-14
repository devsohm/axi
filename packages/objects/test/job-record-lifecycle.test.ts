import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { ObjectsError } from "../src/data/index.ts";
import { defineJob, defineState, int, obj, openStore, sqliteBackend, str } from "../src/index.ts";
import { Documents, Persistence } from "../src/documents/internal.ts";
import type { HostError } from "../src/host/report.ts";
import { JobRecords } from "../src/jobs/records.ts";
import type { JobRun } from "../src/jobs/run.ts";
import { Batch } from "../src/state/internal.ts";
import { ObjectsStore } from "../src/store/store.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";

function owner(store?: ObjectsStore) {
	const errors: HostError[] = [],
		counts: number[] = [];
	const base = {
		label: "app",
		context,
		batch: new Batch((error) => errors.push(error), undefined),
		store: store ? { store, owner: "app" } : undefined,
		fail(error: ObjectsError) {
			throw error;
		},
	};
	const documents = new Documents(base);
	return {
		...base,
		documents,
		host: {
			report: (error: HostError) => {
				errors.push(error);
			},
		},
		countRuns: (delta: number) => {
			counts.push(delta);
		},
		held() {},
		errors,
		counts,
	};
}
const progress = defineState("progress", {
	version: 1,
	schema: obj({ n: int() }),
	initial: () => ({ n: 0 }),
	persist: true,
	checkpointWhen: () => false,
});
const task = defineJob("work", {
	version: 1,
	args: obj({ text: str() }),
	result: str(),
	concurrency: 1,
});

it("deduplicates staged starts, counts committed runs, and retires them atomically with a finish", async () => {
	const app = owner(),
		records = new JobRecords(task, app),
		invoked = Promise.withResolvers<JobRun>();
	records.attach({
		invoke(run) {
			run.begin();
			invoked.resolve(run);
		},
		finish(run) {
			void app.documents.tx(
				(tx) => {
					records.staging(tx).finishing = run;
					records.change(tx, { kind: "delete", run });
				},
				app.documents.own,
				context,
			);
		},
	});
	const handle = await app.documents.tx(
		(tx) => {
			const first = records.stage(tx, { text: "one" }, context, {
				key: "same",
			});
			expect(records.stage(tx, { text: "two" }, context, { key: "same" })).toBe(first);
			expect(() => records.stage(tx, { text: "three" }, context, {})).toThrow("concurrency limit");
			return first;
		},
		app.documents.own,
		context,
	);
	const run = await invoked.promise;
	expect(records.running.value).toEqual([
		{
			id: handle.id,
			version: 1,
			key: "same",
			args: { text: "one" },
			phase: "running",
		},
	]);
	run.invocation?.settle();
	records.settled(run, { kind: "done", result: "answer" });
	expect(await handle.outcome(context)).toEqual({
		id: handle.id,
		args: { text: "one" },
		state: undefined,
		kind: "done",
		result: "answer",
	});
	expect(app.counts).toEqual([1, -1]);
	expect(records.running.value).toEqual([]);
	await expect(records.outcome(handle.id, context)).rejects.toMatchObject({
		code: "gone",
	});
	records.drop();
	app.documents.end();
});

it("reloads crash-interrupted records, preserves state, and ends the fifth consecutive restart", async () => {
	const disk = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	if (!(disk instanceof ObjectsStore)) throw new Error("Unexpected Store");
	const definition = defineJob("saved", {
		version: 1,
		args: obj({ text: str() }),
		result: str(),
		state: progress,
		persist: { resume: "rerun" },
	});
	let app = owner(disk),
		records = new JobRecords(definition, app);
	const handle = await app.documents.tx(
		(tx) => records.stage(tx, { text: "one" }, context, {}),
		app.documents.own,
		context,
	);
	try {
		for (let attempt = 0; attempt <= 5; attempt++) {
			let captured: JobRun | undefined;
			records.attach({
				invoke(run) {
					captured = run;
				},
				finish(run) {
					captured = run;
				},
			});
			if (attempt === 0) await new Promise((resolve) => setImmediate(resolve));
			if (!captured) throw new Error("No recovered run");
			const run = captured;
			expect(run.id).toBe(handle.id);
			expect(records.stateOf(run.id)).toEqual({ n: 0 });
			if (attempt === 5) {
				expect(run.outcome).toEqual({
					id: run.id,
					args: { text: "one" },
					state: { n: 0 },
					kind: "failed",
					error: { kind: "restart_limit", restarts: 5 },
				});
				expect(app.errors).toEqual([
					{
						kind: "job_interrupted",
						object: "app",
						job: "saved",
						id: run.id,
						restarts: 5,
					},
				]);
				break;
			}
			expect(run.restarts).toBe(attempt);
			await app.documents.tx((tx) => records.reserve(tx, run), app.documents.own, context);
			records.end(new ObjectsError({ code: "released", message: "stopped" }));
			records.drop();
			app.documents.end();
			app = owner(disk);
			records = new JobRecords(definition, app);
			await records.load(context);
		}
	} finally {
		records.drop();
		app.documents.end();
		await disk.close(context);
	}
});

it("restores a blocked finish's state and clears its failure count when matching code returns", async () => {
	const disk = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	if (!(disk instanceof ObjectsStore)) throw new Error("Unexpected Store");
	const first = defineJob("saved-finish", {
		version: 1,
		args: int(),
		result: int(),
		state: progress,
		persist: { resume: "rerun" },
	});
	const second = defineJob("saved-finish", {
		version: 2,
		args: int(),
		result: int(),
		state: progress,
		persist: { resume: "rerun" },
	});
	const original = owner(disk),
		records = new JobRecords(first, original);
	const started = Promise.withResolvers<JobRun>();
	records.attach({ invoke: (run) => started.resolve(run), finish() {} });
	const recovered = owner(disk),
		restored = new JobRecords(second, recovered);
	try {
		await original.documents.tx((tx) => records.stage(tx, 3, context, {}), original.documents.own, context);
		const run = await started.promise;
		await original.documents.tx(
			(tx) =>
				records.change(tx, {
					kind: "outcome",
					run,
					outcome: { id: run.id, args: 3, state: { n: 0 }, kind: "done", result: 7 },
				}),
			original.documents.own,
			context,
		);
		await original.documents.tx(
			(tx) => records.change(tx, { kind: "update", run, fields: { finishFailures: 3 } }),
			original.documents.own,
			context,
		);
		records.drop();
		original.documents.end();
		await restored.load(context);
		restored.redefine(first);
		const finishing = Promise.withResolvers<JobRun>();
		restored.attach({ invoke() {}, finish: (run) => finishing.resolve(run) });
		await restored.retryBlocked(context);
		const resumed = await finishing.promise;
		expect(restored.outcomeOf(resumed, context).state).toEqual({ n: 0 });
		expect(resumed.finishFailures).toBe(0);
		const saved = await new Persistence(disk, "app", "objects.jobs", "saved-finish").read(resumed.id, context);
		expect(saved?.value).toMatchObject({ finishFailures: 0 });
	} finally {
		records.drop();
		original.documents.end();
		restored.drop();
		recovered.documents.end();
		await disk.close(context);
	}
});

it("keeps a run's original visible arguments when a replacement adapter throws", async () => {
	const app = owner();
	const first = defineJob("mapping", { version: 1, args: int(), result: int() });
	const records = new JobRecords(first, app);
	try {
		await app.documents.tx((tx) => records.stage(tx, 5, context, {}), app.documents.own, context);
		const next = defineJob("mapping", {
			version: 2,
			args: int(),
			result: int(),
			accepts: {
				1: {
					args() {
						throw new Error("mapping unavailable");
					},
					result: (value: number) => value,
				},
			},
		});
		expect(() => records.redefine(next)).not.toThrow();
		expect(records.running.value).toMatchObject([{ args: 5, phase: "running" }]);
	} finally {
		records.drop();
		app.documents.end();
	}
});

it("rejects schema drift without a version bump while preserving the original declaration", () => {
	const app = owner(),
		records = new JobRecords(task, app);
	try {
		const changed = defineJob("work", { version: 1, args: int(), result: str() });
		expect(() => records.check(changed)).toThrow(/schema changed without a version bump/);
		expect(records.definition).toBe(task);
		expect(() => records.check(task)).not.toThrow();
	} finally {
		records.drop();
		app.documents.end();
	}
});

it.each([false, true])(
	"adding state during reload initializes only newly admitted runs, persisted: %s",
	async (persisted) => {
		const disk = persisted
			? await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)
			: undefined;
		if (disk && !(disk instanceof ObjectsStore)) throw new Error("Unexpected Store");
		const app = owner(disk);
		const first = defineJob("state-added", {
			version: 1,
			args: int(),
			result: int(),
			persist: persisted ? { resume: "rerun" } : undefined,
		});
		const next = defineJob("state-added", {
			version: 2,
			args: int(),
			result: int(),
			state: progress,
			persist: persisted ? { resume: "rerun" } : undefined,
			accepts: { 1: { args: (value: number) => value, result: (value: number) => value } },
		});
		const records = new JobRecords(first, app);
		try {
			const previous = await app.documents.tx((tx) => records.stage(tx, 1, context, {}), app.documents.own, context);
			records.check(next);
			records.redefine(next);
			const current = await app.documents.tx((tx) => records.stage(tx, 2, context, {}), app.documents.own, context);
			expect(records.stateOf(previous.id)).toBeUndefined();
			expect(records.stateOf(current.id)).toEqual({ n: 0 });
			const states = records.states;
			if (!states) throw new Error("Missing newly installed run state");
			await app.documents.tx(
				async (tx) => {
					(await tx.draftSlot(states, current.id)).n = 4;
				},
				app.documents.own,
				context,
			);
			expect(records.running.value).toMatchObject([
				{ id: previous.id, args: 1 },
				{ id: current.id, args: 2, state: { n: 4 } },
			]);
			if (disk)
				expect(
					(await new Persistence(disk, "app", "objects.job-states", "state-added").read(current.id, context))?.value,
				).toEqual({ n: 4 });
		} finally {
			records.drop();
			app.documents.end();
			await disk?.close(context);
		}
	},
);

it("undeclared queued work remains blocked until the same declaration returns", async () => {
	const app = owner(),
		records = new JobRecords(task, app),
		invoked = Promise.withResolvers<JobRun>();
	try {
		const handle = await app.documents.tx(
			(tx) => records.stage(tx, { text: "queued" }, context, {}),
			app.documents.own,
			context,
		);
		records.undeclare();
		records.undeclare();
		await vi.waitFor(() =>
			expect(records.running.value).toMatchObject([{ id: handle.id, phase: "blocked", reason: "version" }]),
		);
		await records.retryBlocked(context);
		expect(records.running.value).toMatchObject([{ phase: "blocked" }]);
		records.redefine(task);
		records.attach({ invoke: (run) => invoked.resolve(run), finish() {} });
		await records.retryBlocked(context);
		expect((await invoked.promise).id).toBe(handle.id);
		expect(records.running.value).toMatchObject([{ id: handle.id, args: { text: "queued" }, phase: "running" }]);
	} finally {
		records.drop();
		app.documents.end();
	}
});

it.each(["done", "failed"] as const)(
	"a version adapter maps a %s outcome without changing the stored run",
	async (kind) => {
		const app = owner(),
			first = defineJob("adapt-outcome", { version: 1, args: int(), result: int() });
		const records = new JobRecords(first, app),
			invoked = Promise.withResolvers<JobRun>();
		records.attach({ invoke: (run) => invoked.resolve(run), finish() {} });
		try {
			await app.documents.tx((tx) => records.stage(tx, 9, context, {}), app.documents.own, context);
			const run = await invoked.promise;
			const outcome =
				kind === "done"
					? { id: run.id, args: 9, state: undefined, kind, result: 7 }
					: { id: run.id, args: 9, state: undefined, kind, error: { kind: "aborted", reason: "abort" } as const };
			await app.documents.tx((tx) => records.change(tx, { kind: "outcome", run, outcome }), app.documents.own, context);
			const next = defineJob("adapt-outcome", {
				version: 2,
				args: int(),
				result: int(),
				accepts: { 1: { args: (value: number) => value + 100, result: (value: number) => value * 10 } },
			});
			records.check(next);
			records.redefine(next);
			const mapped = records.outcomeOf(run, context);
			expect(mapped).toEqual(
				kind === "done"
					? { id: run.id, args: 109, state: undefined, kind, result: 70 }
					: { id: run.id, args: 109, state: undefined, kind, error: { kind: "aborted", reason: "abort" } },
			);
			expect(records.outcomeOf(run, context)).toBe(mapped);
			expect(run.outcome).toEqual(outcome);
			expect(run.args).toBe(9);
		} finally {
			records.drop();
			app.documents.end();
		}
	},
);

it.each([false, true])("aborting blocked work retires its record and state, persisted: %s", async (persisted) => {
	const disk = persisted
		? await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)
		: undefined;
	if (disk && !(disk instanceof ObjectsStore)) throw new Error("Unexpected Store");
	const app = owner(disk),
		definition = defineJob("blocked-abort", {
			version: 1,
			args: int(),
			result: int(),
			state: progress,
			persist: persisted ? { resume: "rerun" } : undefined,
		});
	const records = new JobRecords(definition, app);
	try {
		const handle = await app.documents.tx((tx) => records.stage(tx, 1, context, {}), app.documents.own, context);
		records.undeclare();
		await vi.waitFor(() => expect(records.running.value).toMatchObject([{ phase: "blocked" }]));
		expect(await records.abort(handle.id, context)).toBe("marked");
		await expect(handle.outcome(context)).rejects.toMatchObject({ code: "aborted" });
		expect(records.running.value).toEqual([]);
		expect(records.stateOf(handle.id)).toBeUndefined();
		expect(await records.abort(handle.id, context)).toBe("terminal");
		if (disk)
			for (const table of ["objects.jobs", "objects.job-states"])
				expect(await new Persistence(disk, "app", table, definition.name).read(handle.id, context)).toBeUndefined();
	} finally {
		records.drop();
		app.documents.end();
		await disk?.close(context);
	}
});

it("a discarded admission rejects its handle and does not reserve its key or concurrency slot", async () => {
	const app = owner(),
		records = new JobRecords(task, app);
	let discarded: ReturnType<JobRecords["stage"]> | undefined;
	try {
		await expect(
			app.documents.tx(
				(tx) => {
					discarded = records.stage(tx, { text: "discard" }, context, { key: "same" });
					throw new Error("Caller rolled back");
				},
				app.documents.own,
				context,
			),
		).rejects.toThrow("Caller rolled back");
		if (!discarded) throw new Error("Missing discarded handle");
		await expect(discarded.outcome(context)).rejects.toMatchObject({ code: "released", reason: "discarded" });
		expect(records.running.value).toEqual([]);
		expect(app.counts).toEqual([]);
		const accepted = await app.documents.tx(
			(tx) => records.stage(tx, { text: "accepted" }, context, { key: "same" }),
			app.documents.own,
			context,
		);
		expect(accepted.id).not.toBe(discarded.id);
		expect(records.running.value).toMatchObject([{ id: accepted.id, args: { text: "accepted" } }]);
		expect(app.counts).toEqual([1]);
	} finally {
		records.drop();
		app.documents.end();
	}
});

it.each(["deadline", "close"] as const)(
	"deferred job state is persisted at %s without retiring the running job",
	async (mode) => {
		const disk = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
		if (!(disk instanceof ObjectsStore)) throw new Error("Unexpected Store");
		const app = owner(disk);
		const definition = defineJob("deferred-flush", {
			version: 1,
			args: int(),
			result: int(),
			state: progress,
			persist: { resume: "rerun" },
		});
		const records = new JobRecords(definition, app);
		const saved = new Persistence(disk, "app", "objects.job-states", definition.name);
		try {
			const handle = await app.documents.tx((tx) => records.stage(tx, 1, context, {}), app.documents.own, context);
			const states = records.states;
			if (!states) throw new Error("Missing job state");
			expect(records.nextDeadline()).toBe(Infinity);
			await records.flushHeld(0);
			await app.documents.tx(
				async (tx) => {
					(await tx.draftSlot(states, handle.id)).n = 7;
				},
				app.documents.own,
				context,
				{ kind: "deferred", withinMs: 10000 },
			);
			const deadline = records.nextDeadline();
			expect(Number.isFinite(deadline)).toBe(true);
			expect(records.stateOf(handle.id)).toEqual({ n: 7 });
			expect((await saved.read(handle.id, context))?.value).toEqual({ n: 0 });
			await records.flushHeld(deadline - 1);
			expect(records.nextDeadline()).toBe(deadline);
			expect((await saved.read(handle.id, context))?.value).toEqual({ n: 0 });
			if (mode === "deadline") await records.flushHeld(deadline);
			else await records.writeAtClose(context);
			expect(records.nextDeadline()).toBe(Infinity);
			expect((await saved.read(handle.id, context))?.value).toEqual({ n: 7 });
			expect(records.running.value).toMatchObject([{ id: handle.id, state: { n: 7 } }]);
			await records.flushHeld(Infinity);
			await records.writeAtClose(context);
			expect((await saved.read(handle.id, context))?.value).toEqual({ n: 7 });
		} finally {
			records.drop();
			app.documents.end();
			await disk.close(context);
		}
	},
);
