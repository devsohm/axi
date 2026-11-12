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

it("reads the persistence resume option once after checking its keys", () => {
	let reads = 0;
	const persist = {
		get resume(): "abandon" {
			reads++;
			return "abandon";
		},
	};
	expect(defineJob("work", { version: 1, args: obj({}), result: int(), persist }).persist).toBe(persist);
	expect(reads).toBe(2);
});

it.each(["args", "result"] as const)("accepts a non-enumerable %s version adapter", (field) => {
	const adapter = { args: (old: { n: number }) => old, result: (old: number) => old };
	Object.defineProperty(adapter, field, { enumerable: false });
	const job = defineJob("work", {
		version: 2,
		args: obj({ n: int() }),
		result: int(),
		accepts: { 1: adapter },
	});
	expect(job.accepts[1]).toBe(adapter);
});
