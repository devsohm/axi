import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { openStore, sqliteBackend } from "../src/next/index.ts";
import { PluginError } from "../src/next/data/index.ts";
import { Persistence } from "../src/next/documents/internal.ts";
import { PersistedRuns } from "../src/next/jobs/persisted.ts";
import { JobRun } from "../src/next/jobs/run.ts";
import { outcomeOf, storedRun } from "../src/next/jobs/stored.ts";
import { createDocument } from "../src/next/store/engine.ts";
import type { StagedWrite } from "../src/next/store/step.ts";
import { ObjectsStore } from "../src/next/store/store.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";

it("reloads persisted job records and retires incompatible state without decoding it", async () => {
	const store = await openStore(
		sqliteBackend(await openNodeSqliteDatabase(":memory:")),
		context,
	);
	if (!(store instanceof ObjectsStore))
		throw new Error("Unexpected Store implementation");
	const records = new Persistence(store, "app", "jobs", "job"),
		states = new Persistence(store, "app", "states", "job");
	try {
		const persisted = new PersistedRuns(records, states),
			run = new JobRun("one", 2, "job.fingerprint", "request", { input: "x" }, "pending", {
				traceparent: "test",
			});
		const writes: StagedWrite[] = [],
			adopt = persisted.stage(
				run.id,
				storedRun(run),
				writes,
			);
		writes.push(
			createDocument(
				states.at(run.id),
				{ version: 99, fingerprint: "incompatible", value: { old: true } },
				'{"old":true}',
			),
		);
		await store.commit(writes, { admit: () => true, adopt }, context);
		const reopened = new PersistedRuns(records, states),
			loaded = await reopened.load(context);
		expect(
			loaded.map(({ id, record, stored }) => [id, record, stored.revision]),
		).toEqual([
			[
				"one",
				{
					version: 2,
					fingerprint: "job.fingerprint",
					args: { input: "x" },
					key: "request",
					trace: { traceparent: "test" },
					phase: "pending",
					restarts: 0,
					finishFailures: 0,
				},
				1,
			],
		]);
		run.phase = "finishing";
		const update: StagedWrite[] = [],
			updated = reopened.stage(
				run.id,
				storedRun(run, {
					abortMarked: true,
					finishFailures: 2,
				}),
				update,
			);
		await store.commit(update, { admit: () => true, adopt: updated }, context);
		expect((await reopened.load(context))[0]).toMatchObject({
			record: { phase: "finishing", abort: true, finishFailures: 2 },
			stored: { revision: 2 },
		});
		await reopened.findBlockedState(run.id, context);
		const removals: StagedWrite[] = [],
			removed = reopened.stageRetire(run.id, removals);
		await store.commit(
			removals,
			{ admit: () => true, adopt: removed },
			context,
		);
		expect(await reopened.load(context)).toEqual([]);
		expect(await states.find(run.id, context)).toBeUndefined();
	} finally {
		await store.close(context);
	}
});

it("round-trips a failed job's plugin error without its stack or private cause", () => {
	const run = new JobRun("one", 2, "fp", undefined, {}, "finishing");
	run.outcome = {
		id: run.id,
		args: {},
		state: undefined,
		kind: "failed",
		error: {
			kind: "threw",
			error: new PluginError("quota", "limit", { remaining: 0 }),
		},
	};
	const record = storedRun(run);
	expect(record.outcome).toEqual({
		kind: "failed",
		error: {
			kind: "threw",
			error: {
				kind: "plugin",
				code: "quota",
				message: "limit",
				details: { remaining: 0 },
			},
		},
	});
	const restored = outcomeOf(
		JSON.parse(JSON.stringify(record.outcome)),
		run.id,
		run.args,
		{ n: 3 },
	);
	expect(restored).toMatchObject({
		id: "one",
		state: { n: 3 },
		kind: "failed",
		error: {
			kind: "threw",
			error: { code: "quota", message: "limit", details: { remaining: 0 } },
		},
	});
});
