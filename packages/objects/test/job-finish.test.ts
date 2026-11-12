import { expect, it, vi } from "vitest";
import { InMemoryTelemetryContext } from "@axi/telemetry";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import {
	createHost,
	defineFacet,
	defineJob,
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
