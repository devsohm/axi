import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { defineJob, defineState, obj, str } from "../src/next/index.ts";
import { ObjectsError } from "../src/next/data/index.ts";
import { Documents, SealToken } from "../src/next/documents/internal.ts";
import type { HostError } from "../src/next/host/report.ts";
import { untilAborted } from "../src/next/host/sleep.ts";
import { Job, type AnyJobImplementation } from "../src/next/jobs/job.ts";
import { JobRecords } from "../src/next/jobs/records.ts";
import { Batch } from "../src/next/state/internal.ts";

const progress = defineState("progress", {
	version: 1,
	schema: obj({ output: str() }),
	initial: () => ({ output: "" }),
});
const definition = defineJob("work", {
	version: 1,
	args: obj({}),
	result: str(),
	state: progress,
	concurrency: 1,
});
function setup(implementation: AnyJobImplementation) {
	const errors: HostError[] = [],
		work = new Set<Promise<unknown>>(),
		abort = new AbortController(),
		token = new SealToken();
	const batch = new Batch((error) => errors.push(error), undefined);
	const host = {
		report(error: HostError) {
			errors.push(error);
		},
		async acquire() {
			throw new Error("No dependencies declared");
		},
	};
	const documents = new Documents({
		label: "test",
		context,
		batch,
		store: undefined,
		fail(error) {
			throw error;
		},
	});
	const records = new JobRecords(definition, {
		label: "test",
		host,
		context,
		documents,
		store: undefined,
		countRuns() {},
		held() {},
	});
	const job = new Job(records, implementation, {
		host,
		caller: { principal: { kind: "owner" }, incarnation: "test" },
		context,
		documents,
		token,
		signal: abort.signal,
		admit(promise, cleanup) {
			work.add(promise);
			promise.then(
				() => {
					work.delete(promise);
					cleanup?.();
				},
				() => {
					work.delete(promise);
					cleanup?.();
				},
			);
		},
		admitRun(promise, cleanup) {
			this.admit(promise, cleanup);
		},
	});
	return {
		job,
		records,
		errors,
		documents,
		async close() {
			const reason = new ObjectsError({ code: "released", message: "closed" });
			job.seal(reason);
			documents.fence(token);
			abort.abort(reason);
			await Promise.allSettled(work);
			records.end(reason);
			records.drop();
			documents.end();
		},
	};
}
const flushed = async (): Promise<void> => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
};

it("executes after activation and commits progress, finish and cleanup before resolving a run", async () => {
	const seen: unknown[] = [],
		finished: unknown[] = [];
	const app = setup({
		async run(_args, ctx) {
			seen.push([ctx.principal, ctx.incarnation, ctx.jobId]);
			await ctx.state?.change((draft) => {
				draft.output = "working";
			}, ctx);
			return "done";
		},
		finish(outcome) {
			finished.push(outcome);
		},
	});
	try {
		await expect(app.job.start({}, context)).rejects.toMatchObject({
			code: "not_ready",
		});
		app.job.live();
		const run = await app.job.start({}, context);
		expect(await run.outcome(context)).toEqual({
			id: run.id,
			args: {},
			state: { output: "working" },
			kind: "done",
			result: "done",
		});
		expect(seen).toEqual([[{ kind: "owner" }, "test", run.id]]);
		expect(finished).toHaveLength(1);
		expect(app.job.running.value).toEqual([]);
		expect(app.errors).toEqual([]);
	} finally {
		await app.close();
	}
});
it("allows an aborting invocation to record its last progress before abort joins it", async () => {
	const entered = Promise.withResolvers<void>();
	const app = setup({
		async run(_args, ctx) {
			entered.resolve();
			await untilAborted(ctx);
			await ctx.state?.change((draft) => {
				draft.output = "stopped";
			}, ctx);
			throw new Error("aborted");
		},
	});
	try {
		app.job.live();
		const run = await app.job.start({}, context);
		await entered.promise;
		expect(await app.job.abort(run.id, context)).toBe("marked");
		expect(await run.outcome(context)).toEqual({
			id: run.id,
			args: {},
			state: { output: "stopped" },
			kind: "failed",
			error: { kind: "aborted", reason: "abort" },
		});
		expect(app.errors).toEqual([]);
		expect(await app.job.abort(run.id, context)).toBe("terminal");
	} finally {
		await app.close();
	}
});
it("backs off failed finishes and blocks the fifth failure until abort drops the run", async () => {
	vi.useFakeTimers();
	let finishes = 0;
	const app = setup({
		async run() {
			return "done";
		},
		finish() {
			finishes++;
			throw new Error("finish failed");
		},
	});
	try {
		app.job.live();
		const run = await app.job.start({}, context);
		await flushed();
		for (const delay of [1000, 2000, 4000, 8000]) await vi.advanceTimersByTimeAsync(delay);
		expect(finishes).toBe(5);
		expect(app.job.running.value).toEqual([{ id: run.id, version: 1, phase: "blocked", reason: "finish_failed" }]);
		expect(app.errors.filter((error) => error.kind === "job_finish_failed")).toHaveLength(5);
		expect(await app.job.abort(run.id, context)).toBe("marked");
		await expect(run.outcome(context)).rejects.toMatchObject({
			code: "aborted",
		});
		expect(app.job.running.value).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		await app.close();
		vi.useRealTimers();
	}
});
it("rejects malformed persistence options as a promise without changing run state", async () => {
	const app = setup({
		async run(_args, ctx) {
			const state = ctx.state;
			if (!state) throw new Error("Missing run state");
			await expect(
				state.change(
					(draft) => {
						draft.output = "wrong";
					},
					ctx,
					{ persistence: null as never },
				),
			).rejects.toBeInstanceOf(TypeError);
			await expect(
				state.change(
					(draft) => {
						draft.output = "wrong";
					},
					ctx,
					{ persistence: { kind: "deferred", withinMs: -1 } },
				),
			).rejects.toMatchObject({ code: "invalid", reason: "args" });
			return "done";
		},
	});
	try {
		app.job.live();
		const run = await app.job.start({}, context);
		expect(await run.outcome(context)).toMatchObject({
			kind: "done",
			state: { output: "" },
		});
		expect(app.errors).toEqual([]);
	} finally {
		await app.close();
	}
});
