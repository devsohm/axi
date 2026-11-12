import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import {
	createHost,
	defineFacet,
	defineJob,
	defineState,
	int,
	type JobHandle,
	type JobImplementation,
	local,
	type Outcome,
	obj,
	openStore,
	sqliteBackend,
	str,
} from "../../src/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";

type Progress = { completed: number };
export type JobOutcome = Outcome<string, number, Progress>;
const Progress = defineState("checkpoint", {
	schema: obj({ completed: int() }),
	version: 1,
	initial: () => ({ completed: 0 }),
	persist: true,
	checkpointWhen: () => false,
});
const Runner = local("checkpoint.runner", { version: 1, params: {}, members: {} });

export async function openCheckpointJob(
	path: string,
	policy: "rerun" | "abandon",
	run: JobImplementation<string, number, Progress>["run"],
	finish?: (outcome: JobOutcome) => Promise<void>,
) {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
	const errors: unknown[] = [];
	const host = createHost({ store, onError: (error) => errors.push(error) });
	const Work = defineJob("checkpoint.work", {
		version: 1,
		args: str(),
		result: int(),
		state: Progress,
		persist: { resume: policy },
	});
	let jobs: JobHandle<string, number, Progress> | undefined;
	try {
		await host.load(
			[
				{
					name: "checkpoint",
					facet: defineFacet((h) =>
						h.serve(Runner, (_, self) => {
							jobs = self.job(Work, { run, finish: async (outcome) => finish?.(outcome) });
							return {};
						}),
					),
				},
			],
			context,
		);
		if (!jobs) throw new Error("Checkpoint job did not load");
		return { host, store, jobs, errors };
	} catch (error) {
		await host.close(context);
		await store.close(context);
		throw error;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [path, policy] = process.argv.slice(2);
	if (!path || (policy !== "rerun" && policy !== "abandon")) throw new Error("Expected a database path and policy");
	process.on("disconnect", () => process.exit(0));
	const saved = Promise.withResolvers<void>();
	const fixture = await openCheckpointJob(path, policy, async (_args, ctx) => {
		await ctx.state.change((draft) => {
			draft.completed = 41;
		}, ctx);
		saved.resolve();
		return new Promise(() => {});
	});
	const run = await fixture.jobs.start("archive", context);
	await saved.promise;
	process.send?.({ kind: "ready", id: run.id });
}
