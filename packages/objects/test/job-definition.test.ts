import { expect, it } from "vitest";
import {
	bytes,
	defineJob,
	defineState,
	int,
	obj,
	str,
} from "../src/index.ts";

it("snapshots job schemas and enforces the persistence requirements at declaration", () => {
	const Progress = defineState("progress", {
		schema: obj({ n: int() }),
		version: 1,
		initial: () => ({ n: 0 }),
		persist: true,
		checkpointWhen: () => false,
	});
	const args = obj({ input: str() });
	const job = defineJob("build", {
		version: 2,
		args,
		result: int(),
		state: Progress,
		concurrency: 2,
		persist: { resume: "rerun" },
		accepts: {
			1: {
				args: (old: { name: string }) => ({ input: old.name }),
				result: (old: number) => old,
			},
		},
	});
	Object.assign(args.properties.input, {
		description: "caller changed the schema",
	});
	expect(job.args.schema).toEqual(obj({ input: str() }));
	expect(
		Reflect.apply(job.accepts[1]!.args, undefined, [{ name: "target" }]),
	).toEqual({ input: "target" });
	expect(() =>
		defineJob("invalid", {
			version: 1,
			args: obj({ value: bytes() }),
			result: int(),
		}),
	).toThrow("job arguments are JSON");
	expect(() =>
		defineJob("invalid", {
			version: 1,
			args,
			result: bytes(),
			persist: { resume: "abandon" },
		}),
	).toThrow("a persisted job's result is JSON");
});
