import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../src/context/index.ts";
import { ObjectsError } from "../src/data/index.ts";
import { JobRun } from "../src/jobs/run.ts";

it("keeps its originating version and fingerprint while presenting adapted arguments", () => {
	const run = new JobRun("run", 2, "job-v2", "request", { input: 1 }, "running");
	expect(run.fingerprint).toBe("job-v2");
	expect(run.entryFor(undefined, { value: 1 })).toEqual({
		id: "run",
		version: 2,
		key: "request",
		args: { value: 1 },
		phase: "running",
	});
	expect(run.args).toEqual({ input: 1 });
});

it("cancels only the caller's wait and gives settled outcomes to every other waiter", async () => {
	const run = new JobRun("job", 1, "job-v1", undefined, { n: 1 }, "running"),
		cancelled = withCancel(context);
	const first = run.handle.outcome(cancelled.context),
		second = run.handle.outcome(context);
	cancelled.cancel(new Error("stop waiting"));
	await expect(first).rejects.toThrow("stop waiting");
	const result = {
		id: "job",
		args: { n: 1 },
		state: undefined,
		kind: "done",
		result: 2,
	} as const;
	run.resolve(result);
	expect(await second).toBe(result);
	expect(await run.handle.outcome(cancelled.context)).toBe(result);
	run.reject(new ObjectsError({ code: "aborted", message: "too late" }));
	expect(await run.handle.outcome(context)).toBe(result);
});
it("keeps replacement invocations' end waits independent", async () => {
	const run = new JobRun("job", 1, "job-v1", "key", {}, "pending"),
		first = run.begin(),
		cancelled = withCancel(context);
	const left = first.over(cancelled.context);
	cancelled.cancel(new Error("left"));
	await expect(left).rejects.toThrow("left");
	first.settle();
	first.ended();
	const second = run.begin();
	let over = false;
	const wait = run.over(context).then(() => {
		over = true;
	});
	first.ended();
	await Promise.resolve();
	expect(over).toBe(false);
	second.settle();
	second.ended();
	await wait;
	expect(over).toBe(true);
	expect(run.invoked).toBe(false);
});
