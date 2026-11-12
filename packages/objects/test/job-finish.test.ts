import { expect, it, vi } from "vitest";
import { InMemoryTelemetryContext } from "@axi/telemetry";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import {
	createHost,
	defineFacet,
	defineJob,
	defineState,
	int,
	local,
	obj,
	str,
	unknown as json,
	type JobHandle,
} from "../src/index.ts";

it("keeps the finish span open while publishing its final blocked state", async () => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	const telemetry = new InMemoryTelemetryContext();
	const ready = Promise.withResolvers<JobHandle<{}, string, undefined>>();
	const observed = Promise.withResolvers<boolean>();
	const errors: string[] = [];
	const host = createHost({ telemetry, onError(error) { errors.push(error.kind); } });
	const Runner = local("finish.runner", { version: 1, params: {}, members: { running: json() } });
	const Work = defineJob("finish.work", { version: 1, args: obj({}), result: str() });
	try {
		await host.load([{
			name: "runner",
			facet: defineFacet((h) => h.serve(Runner, (_params, self) => {
				const job = self.job(Work, {
					run: async () => "done",
					finish() { throw new Error("finish unavailable"); },
				});
				ready.resolve(job);
				return { running: job.running };
			})),
		}], context);
		const job = await ready.promise;
		const watch = await job.running.watch(context);
		try {
			watch.start(async (frame) => {
				if (frame.kind === "value" && frame.value.some((run) => run.phase === "blocked")) {
					const span = telemetry.getSpans().find((entry) => entry.name === "objects.job" && entry.attributes.phase === "finish");
					if (!span) throw new Error("Missing finish span");
					observed.resolve(span.settled);
				}
			});
			await job.start({}, context);
			for (const delay of [1000, 2000, 4000, 8000]) await vi.advanceTimersByTimeAsync(delay);
			expect(await observed.promise).toBe(false);
			expect(errors.filter((kind) => kind === "job_finish_failed")).toHaveLength(5);
			await vi.waitFor(() => expect(telemetry.getSpans().find((entry) => entry.attributes.phase === "finish")?.settled).toBe(true));
		} finally {
			await watch.stop();
		}
	} finally {
		await host.close(context);
		vi.useRealTimers();
	}
});

it("adapts an older result before migrating the state passed to its new finish", async () => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	const order: string[] = [];
	const outcomes: unknown[] = [];
	const resumedCounts: number[] = [];
	const ready = Promise.withResolvers<JobHandle<{}, string, { n: number }>>();
	const errors: string[] = [];
	const host = createHost({ onError(error) { errors.push(error.kind); } });
	const Runner = local("migration.runner", { version: 1, params: {}, members: { running: json(), count: int() } });
	const State = defineState("migration.state", { version: 1, schema: obj({ n: int() }), initial: () => ({ n: 0 }) });
	const NextState = defineState("migration.state", {
		version: 2,
		schema: obj({ n: int() }),
		initial: () => ({ n: 0 }),
		migrate(old) { order.push("state"); return { n: Number(old.n) }; },
	});
	const Work = defineJob("migration.work", { version: 1, args: obj({}), result: str(), state: State });
	const NextWork = defineJob("migration.work", {
		version: 2,
		args: obj({}),
		result: str(),
		state: NextState,
		accepts: { 1: { args: (old: {}) => old, result: (old: string) => { order.push("result"); return old; } } },
	});
	try {
		await host.load([{
			name: "runner",
			facet: defineFacet((h) => h.serve(Runner, (_params, self) => {
				const job = self.job(Work, {
					run: async () => "done",
					finish() { throw new Error("old finish unavailable"); },
				});
				ready.resolve(job);
				return { running: job.running, count: self.derive([job.running], () => host.activity.value.jobs) };
			})),
		}], context);
		const job = await ready.promise;
		const ref = await host.get(Runner, {}, context);
		const counts = await ref.count.watch(context);
		counts.start(async () => {});
		const run = await job.start({}, context);
		for (const delay of [1000, 2000, 4000, 8000]) await vi.advanceTimersByTimeAsync(delay);
		expect(job.running.value).toMatchObject([{ phase: "blocked", reason: "finish_failed" }]);
		await host.reload([{
			name: "runner",
			facet: defineFacet((h) => h.serve(Runner, (_params, self) => {
				const next = self.job(NextWork, { run: async () => "next", finish(outcome) { outcomes.push(outcome); } });
				const count = self.derive([next.running], ([runs]) => {
					if (runs.some((run) => run.phase === "finishing")) resumedCounts.push(host.activity.value.jobs);
					return host.activity.value.jobs;
				});
				return { running: next.running, count };
			})),
		}], context);
		expect(await run.outcome(context)).toMatchObject({ kind: "done", result: "done" });
		expect(outcomes).toMatchObject([{ kind: "done", result: "done", state: { n: 0 } }]);
		expect(order).toEqual(["result", "state"]);
		expect(resumedCounts).toEqual([1]);
		expect(errors.filter((kind) => kind === "job_finish_failed")).toHaveLength(5);
		await counts.stop();
		ref.release();
	} finally {
		await host.close(context);
		vi.useRealTimers();
	}
});
