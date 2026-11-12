import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import {
	constant,
	createHost,
	defineFacet,
	defineState,
	int,
	keyed,
	local,
	method,
	obj,
	type HostError,
} from "../src/index.ts";

test("an activation failure before dependency checking is reported as a retry rather than a parked dependency", async () => {
	const Value = local("reload.failed-initial-value", { version: 1, params: {}, members: { value: int() } });
	const State = defineState("invalid-initial", {
		version: 1,
		schema: obj({ value: int() }),
		initial: (): { value: number } => {
			throw new Error("initial value unavailable");
		},
	});
	const host = createHost({ onError() {} });
	try {
		await host.load(
			[
				{
					name: "value",
					facet: defineFacet((h) =>
						h.serve(Value, (_, self) => {
							self.open(
								async () => {
									throw new Error("old resource unavailable");
								},
								() => {},
							);
							return { value: constant(1) };
						}),
					),
				},
			],
			context,
		);
		const ref = host.hold(Value, {}, context);
		await vi.waitFor(() => expect(ref.state.value.kind).toBe("failed"));
		const report = await host.reload(
			[
				{
					name: "value",
					facet: defineFacet((h) =>
						h.serve(Value, (_, self) => ({
							value: self.derive([self.state(State)], ([state]) => state.value),
						})),
					),
				},
			],
			context,
		);
		expect(report.failed).toEqual([]);
		expect(report.objects).toEqual([{ object: Value.name, kind: "retried" }]);
		await vi.waitFor(() =>
			expect(ref.state.value).toMatchObject({
				kind: "failed",
				cause: { kind: "broken", error: { message: expect.stringContaining("initial value unavailable") } },
			}),
		);
		ref.release();
	} finally {
		await host.close(context);
	}
});

test("removing an object rejects new calls waiting behind its outgoing work", async () => {
	const Value = local("reload.waiting-call", {
		version: 1,
		params: {},
		members: { work: method(undefined, int()), ping: method(undefined, int()) },
	});
	const entered = Promise.withResolvers<void>(),
		finish = Promise.withResolvers<void>();
	const plugin = (n: number) => ({
		name: "value",
		facet: defineFacet((h) =>
			h.serve(Value, () => ({
				work: async () => {
					entered.resolve();
					await finish.promise;
					return 1;
				},
				ping: async () => n,
			})),
		),
	});
	const host = createHost({ readyTimeout: 1000, reloadDrainTimeout: 100, closeTimeout: 100, onError() {} });
	const outcomes: unknown[] = [];
	try {
		await host.load([plugin(1)], context);
		const ref = await host.get(Value, {}, context);
		const old = ref.work(context).catch(() => {});
		await entered.promise;
		await host.reload([plugin(2)], context);
		const waiting = ref.ping(context).then(
			(value) => {
				outcomes.push(value);
			},
			(error: unknown) => {
				outcomes.push(error);
			},
		);
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			await host.reload([], context);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(outcomes).toEqual([expect.objectContaining({ code: "released" })]);
		} finally {
			finish.resolve();
			await Promise.all([old, waiting]);
			ref.release();
		}
	} finally {
		finish.resolve();
		await host.close(context);
	}
});

test("reports a pinned key that remains blocked after its initial value fails", async () => {
	vi.useFakeTimers();
	const shape = obj({ n: int() });
	const Notes = local("activation.notes", { version: 1, params: {}, members: { notes: keyed(shape) } });
	const Reader = local("activation.reader", { version: 1, params: {}, members: { value: shape } });
	let available = false;
	const State = defineState("notes", {
		version: 1,
		schema: shape,
		keyed: true,
		initial: () => {
			if (!available) throw new Error("key unavailable");
			return { n: 7 };
		},
	});
	const reports: HostError[] = [],
		host = createHost({ readyTimeout: 20, onError: (error) => reports.push(error) });
	try {
		await host.load(
			[
				{ name: "notes", facet: defineFacet((h) => h.serve(Notes, (_, self) => ({ notes: self.state(State) }))) },
				{
					name: "reader",
					facet: defineFacet((h) =>
						h.serve(Reader, (_, self) => ({
							value: self.get(Notes, {}).notes.at("a"),
						})),
					),
				},
			],
			context,
		);
		const reader = host.hold(Reader, {}, context);
		expect(reader.state.value.kind).toBe("failed");
		await vi.advanceTimersByTimeAsync(20);
		expect(reports.filter((error) => error.kind === "parked_long")).toEqual([
			expect.objectContaining({ kind: "parked_long", object: Reader.name, waitingFor: Notes.name, state: "failed" }),
		]);
		available = true;
		reader.retry();
		await vi.advanceTimersByTimeAsync(0);
		expect(reader.state.value.kind).toBe("live");
		expect(reader.value.value).toEqual({ n: 7 });
		reader.release();
	} finally {
		await host.close(context);
		vi.useRealTimers();
	}
});
