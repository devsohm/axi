import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { References } from "../src/host/presence.ts";
import { Batch } from "../src/state/internal.ts";

it("lists local and remote holders and folds removals and additions in commit order", async () => {
	const batch = new Batch(() => {}, undefined),
		references = new References(batch),
		frames: unknown[] = [];
	const local = { params: { id: 1 }, served: { kind: "local" } } as const,
		remote = { params: { id: 2 }, served: { kind: "remote" } } as const;
	const holders = ["a", "b", "c"].map((incarnation) => ({
		caller: { principal: { kind: "member" }, incarnation },
	}));
	const watch = await references.watch(context);
	watch.start(async (call) => {
		frames.push(call);
	});
	batch.commit(() => {
		references.add(local, holders[0]!, context);
		references.add(remote, holders[1]!, context);
	}, context);
	const first = [
		{ params: { id: 1 }, incarnation: "a" },
		{ params: { id: 2 }, principal: { kind: "member" }, incarnation: "b" },
	];
	expect(references.value).toEqual(first);
	for (let i = 0; i < 6; i++) await Promise.resolve();
	batch.commit(() => {
		references.remove([holders[0]!], context);
		references.add(local, holders[2]!, context);
	}, context);
	for (let i = 0; i < 6; i++) await Promise.resolve();
	expect(frames).toEqual([
		{
			kind: "value",
			value: first,
			ops: [["p", [], 0, 0, first]],
			retired: false,
		},
		{
			kind: "value",
			value: [first[1], { params: { id: 1 }, incarnation: "c" }],
			ops: [
				["p", [], 0, 1, []],
				["p", [], 1, 0, [{ params: { id: 1 }, incarnation: "c" }]],
			],
			retired: false,
		},
	]);
	await watch.stop();
});
