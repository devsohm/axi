import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { ObjectsError } from "../src/data/index.ts";
import {
	defineJob,
	defineState,
	int,
	obj,
	openStore,
	sqliteBackend,
	str,
} from "../src/index.ts";
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
			expect(records.stage(tx, { text: "two" }, context, { key: "same" })).toBe(
				first,
			);
			expect(() => records.stage(tx, { text: "three" }, context, {})).toThrow(
				"concurrency limit",
			);
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
	const disk = await openStore(
		sqliteBackend(await openNodeSqliteDatabase(":memory:")),
		context,
	);
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
			await app.documents.tx(
				(tx) => records.reserve(tx, run),
				app.documents.own,
				context,
			);
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
	const first = defineJob("saved-finish", { version: 1, args: int(), result: int(), state: progress,
		persist: { resume: "rerun" } });
	const second = defineJob("saved-finish", { version: 2, args: int(), result: int(), state: progress,
		persist: { resume: "rerun" } });
	const original = owner(disk), records = new JobRecords(first, original);
	const started = Promise.withResolvers<JobRun>();
	records.attach({ invoke: (run) => started.resolve(run), finish() {} });
	const recovered = owner(disk), restored = new JobRecords(second, recovered);
	try {
		await original.documents.tx((tx) => records.stage(tx, 3, context, {}), original.documents.own, context);
		const run = await started.promise;
		await original.documents.tx((tx) => records.change(tx, { kind: "outcome", run,
			outcome: { id: run.id, args: 3, state: { n: 0 }, kind: "done", result: 7 } }), original.documents.own, context);
		await original.documents.tx((tx) => records.change(tx, { kind: "update", run,
			fields: { finishFailures: 3 } }), original.documents.own, context);
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
		const next = defineJob("mapping", { version: 2, args: int(), result: int(), accepts: {
			1: { args() { throw new Error("mapping unavailable"); }, result: (value: number) => value },
		} });
		expect(() => records.redefine(next)).not.toThrow();
		expect(records.running.value).toMatchObject([{ args: 5, phase: "running" }]);
	} finally {
		records.drop();
		app.documents.end();
	}
});
