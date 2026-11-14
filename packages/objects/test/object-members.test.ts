import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import type { JsonValue } from "../src/json.ts";
import { ObjectsError } from "../src/data/index.ts";
import { MemberSource } from "../src/host/member-source.ts";
import { ReferenceState, type RefState } from "../src/host/ref-state.ts";
import { Batch, Constant } from "../src/state/internal.ts";
import { constant, createHost, defineFacet, int, local } from "../src/index.ts";

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
it("shares the terminal record when references release their member watches", async () => {
	const type = local("members.terminal", { version: 1, params: {}, members: { value: int() } });
	const host = createHost({
		onError(error) {
			throw error;
		},
	});
	try {
		await host.load(
			[{ name: "values", facet: defineFacet((h) => h.serve(type, () => ({ value: constant(3) }))) }],
			context,
		);
		const first = await host.get(type, {}, context),
			second = await host.get(type, {}, context);
		const watches = await Promise.all([
			first.value.watch(context),
			first.value.watch(context),
			second.value.watch(context),
		]);
		first.release();
		second.release();
		const ends = await Promise.all(watches.map((watch) => watch.closed));
		expect(ends[0]).toEqual({ kind: "ended" });
		for (const end of ends) expect(end).toBe(ends[0]);
	} finally {
		await host.close(context);
	}
});

it("retains reference states in order and ends watches when the reference is released", async () => {
	let state: RefState = { kind: "loading" };
	const batch = new Batch(() => {}, undefined),
		source = new ReferenceState(() => state, batch),
		seen: string[] = [];
	const watch = await source.watch(context);
	watch.start(async (call) => {
		if (call.kind === "value") seen.push(call.value.kind);
	});
	state = {
		kind: "failed",
		cause: {
			kind: "transient",
			error: new ObjectsError({ code: "unavailable", message: "offline" }),
		},
		retryAt: 10,
	};
	source.moved();
	await turn();
	state = { kind: "loading" };
	source.moved();
	await turn();
	state = { kind: "live" };
	source.moved();
	await turn();
	expect(seen).toEqual(["failed", "loading", "live"]);
	state = {
		kind: "ended",
		error: new ObjectsError({ code: "released", message: "released" }),
	};
	source.released(state);
	expect(await watch.closed).toEqual({ kind: "ended" });
	const late = await source.watch(context);
	expect(late.value.kind).toBe("ended");
	expect(await late.closed).toEqual({ kind: "ended" });
});

it("freezes a member and resumes its watch with a diff or a full value after failure", async () => {
	const batch = new Batch(() => {}, undefined),
		source = new MemberSource(new Constant<JsonValue>({ n: 1 }), batch),
		calls: unknown[] = [];
	const watch = await source.watch(context);
	watch.start(async (call) => {
		calls.push(call);
	});
	source.freeze();
	expect(source.value).toEqual({ n: 1 });
	batch.commit(() => source.bind(new Constant<JsonValue>({ n: 2 })), context);
	await turn();
	const failure = new ObjectsError({
		code: "invalid",
		reason: "member",
		message: "member absent",
	});
	batch.commit(() => source.vanish(failure, context), context);
	await turn();
	expect(() => source.value).toThrow("member absent");
	batch.commit(() => source.bind(new Constant<JsonValue>({ n: 3 })), context);
	await turn();
	expect(calls).toEqual([
		{ kind: "value", value: { n: 2 }, ops: [["s", ["n"], 2]], retired: false },
		{ kind: "failed", error: failure },
		{ kind: "value", value: { n: 3 }, ops: [["r", { n: 3 }]], retired: false },
	]);
	source.objectEnded(new ObjectsError({ code: "released", message: "ended" }));
	expect(await watch.closed).toEqual({ kind: "ended" });
	expect(() => source.value).toThrow("ended");
});
