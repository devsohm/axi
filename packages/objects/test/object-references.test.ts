import { HostEvents } from "../src/host/events.ts";
import { objectsMetrics } from "../src/telemetry.ts";
import { getEventListeners } from "node:events";
import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "../src/context/index.ts";
import type { JsonValue } from "../src/json.ts";
import { int, local, method, obj, str } from "../src/contracts/index.ts";
import { ObjectsError } from "../src/data/index.ts";
import { CallContext, withLinkedAbortSignal } from "../src/host/ctx.ts";
import { Binding, type Target, type Reference } from "../src/host/reference.ts";
import { LIVE, LOADING, type RefState } from "../src/host/ref-state.ts";
import { RootScopes } from "../src/host/root.ts";
import { Batch, Constant } from "../src/state/internal.ts";
const contract = local("test.counter", {
	version: 1,
	params: {},
	members: { n: int(), echo: method(obj({ text: str() }), str()) },
});
const caller = { principal: { kind: "user" }, incarnation: "test" };

function provider() {
	const events = new HostEvents(objectsMetrics(undefined), () => {});
	const batch = new Batch(() => {}, undefined),
		holders = new Set<Binding>(),
		calls: unknown[] = [];
	let state: RefState = LOADING;
	const source = new Constant<JsonValue>(4);
	const target: Target = {
		kind: "local",
		stateFor: () => state,
		label: "test.counter",
		get state() {
			return state;
		},
		get hydrated() {
			return state.kind === "live";
		},
		variant: undefined,
		lastFailure: undefined,
		activationId: undefined,
		heldOnLink: false,
		blocksFirstPass: true,
		lastValues: false,
		hold(binding) {
			holders.add(binding);
		},
		unhold(binding) {
			holders.delete(binding);
		},
		member() {
			return source;
		},
		keyedMember() {
			throw new Error("No keyed members");
		},
		async pinKey() {
			throw new Error("No keyed members");
		},
		retry() {},
		pathTo() {
			return undefined;
		},
		async call(name, args, caller, _context) {
			calls.push([name, args, caller.principal]);
			return args;
		},
	};
	return {
		events,
		batch,
		calls,
		holders,
		target,
		move(next: RefState) {
			state = next;
			batch.within(() => {
				for (const holder of holders) holder.retarget();
			}, context);
			for (const holder of holders) holder.moved();
		},
	};
}

it("parks methods until live, forwards caller identity, and ends member watches on release", async () => {
	const app = provider(),
		binding = new Binding(contract, app.batch, undefined, caller, 100, app.events);
	const ref = binding.reference as Reference<typeof contract>;
	const first = ref.echo({ text: "one" }, context),
		second = ref.echo({ text: "two" }, context);
	binding.bind(app.target);
	app.move(LIVE);
	expect(await first).toEqual({ text: "one" });
	expect(await second).toEqual({ text: "two" });
	expect(app.calls).toEqual([
		["echo", { text: "one" }, { kind: "user" }],
		["echo", { text: "two" }, { kind: "user" }],
	]);
	expect(ref.n.value).toBe(4);
	const watch = await ref.n.watch(context);
	ref.release();
	ref.release();
	await watch.closed;
	expect(app.holders.size).toBe(0);
	expect(ref.state.value.kind).toBe("ended");
	await expect(ref.echo({ text: "late" }, context)).rejects.toMatchObject({
		code: "released",
	});
});
it("releases call-scoped references and rejects a get that resolves after its scope settles", async () => {
	const app = provider(),
		gates = [Promise.withResolvers<Binding>(), Promise.withResolvers<Binding>()];
	const acquired: Binding[] = [];
	let next = 0;
	const host = { incarnation: "host", spanHost: "client", acquire: () => gates[next++]!.promise };
	const scope = new CallContext(context, caller, host);
	const first = scope.get(contract, {}),
		second = scope.get(contract, {});
	const one = new Binding(contract, app.batch, undefined, caller, 100, app.events),
		two = new Binding(contract, app.batch, undefined, caller, 100, app.events);
	for (const binding of [one, two]) {
		binding.bind(app.target);
		acquired.push(binding);
	}
	app.move(LIVE);
	gates[0]!.resolve(one);
	const ref = await first;
	scope.settle();
	gates[1]!.resolve(two);
	await expect(second).rejects.toMatchObject({
		code: "released",
		reason: "settled",
	});
	expect(ref.state.value.kind).toBe("ended");
	expect(acquired.map((binding) => binding.refState.kind)).toEqual(["ended", "ended"]);
	expect(app.holders.size).toBe(0);
});
it("links the caller signal selected during setup", () => {
	const selected = new AbortController(),
		other = new AbortController(),
		call = new AbortController();
	other.abort("other");
	let reads = 0;
	const linked = withLinkedAbortSignal(call.signal, {
		get abortSignal() {
			return ++reads === 1 ? selected.signal : other.signal;
		},
		telemetry: context.telemetry,
		value: (key) => context.value(key),
		toString: () => "selected cancellation",
	});
	try {
		expect(linked.context.abortSignal?.aborted).toBe(false);
		selected.abort("selected");
		expect(linked.context.abortSignal?.reason).toBe("selected");
		expect(reads).toBe(1);
	} finally {
		linked.release();
	}
});

it("detaches linked cancellation listeners and closes root scopes around uncooperative work", async () => {
	const callerAbort = new AbortController(),
		callAbort = new AbortController();
	const base = withAbortSignal(callerAbort.signal, context),
		linked = withLinkedAbortSignal(callAbort.signal, base);
	const callerSignal = base.abortSignal!;
	expect(getEventListeners(callerSignal, "abort")).toHaveLength(1);
	linked.release();
	callAbort.abort("late");
	expect(linked.context.abortSignal?.aborted).toBe(false);
	expect(getEventListeners(callerSignal, "abort")).toHaveLength(0);
	const scopes = new RootScopes({
		spanHost: "client",
		incarnation: "host",
		async acquire() {
			throw new Error("Unused");
		},
	});
	const finish = Promise.withResolvers<void>(),
		entered = Promise.withResolvers<void>();
	let signal: AbortSignal | undefined;
	const running = scopes.run(
		async (ctx) => {
			signal = ctx.abortSignal;
			entered.resolve();
			await finish.promise;
			return 5;
		},
		caller.principal,
		context,
	);
	await entered.promise;
	const reason = new ObjectsError({ code: "released", message: "host closed" });
	scopes.close(reason);
	await expect(running).rejects.toBe(reason);
	expect(signal?.aborted).toBe(true);
	finish.resolve();
});
