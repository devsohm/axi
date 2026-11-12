import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel, type Context } from "../src/context/index.ts";
import {
	createHost,
	defineFacet,
	event,
	hostKind,
	local,
	memoryLinkPair,
	method,
	remote,
	str,
	type EventSource,
} from "../src/index.ts";
import { TuiScope } from "../src/tui/scope.ts";

test("an already cancelled event subscription retains its selected cancellation reason", async () => {
	const Feed = local("cancelled-event-feed", { version: 1, params: {}, members: { next: event(str()) } });
	const host = createHost({ onError() {} });
	const sources: EventSource<string>[] = [];
	const reason = new Error("subscription cancelled"),
		controller = new AbortController();
	controller.abort(reason);
	let reads = 0;
	const invocation: Context = {
		get abortSignal() {
			return ++reads === 1 ? controller.signal : undefined;
		},
		telemetry: context.telemetry,
		value: (key) => context.value(key),
		toString: () => "cancelled subscription",
	};
	try {
		await host.load(
			[
				{
					name: "feed",
					facet: defineFacet((h) =>
						h.serve(Feed, (_, self) => {
							const next = self.events<string>();
							sources.push(next);
							return { next };
						}),
					),
				},
			],
			context,
		);
		const ref = await host.get(Feed, {}, context);
		try {
			const listener = vi.fn();
			await expect((async () => sources[0]!.on(listener, invocation))()).rejects.toBe(reason);
			expect(reads).toBe(1);
			sources[0]!.emit("after cancellation");
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(listener).not.toHaveBeenCalled();
		} finally {
			ref.release();
		}
	} finally {
		await host.close(context);
	}
});

test("queued events honor stopped listeners and isolate a failed subscriber", async () => {
	const Feed = local("ordered-feed", { version: 1, params: { name: str() }, members: { next: event(str()) } });
	const errors: unknown[] = [],
		sources = new Map<string, EventSource<string>>(),
		seen: string[] = [];
	const host = createHost({
		onError: (error) => {
			errors.push(error);
		},
	});
	try {
		await host.load(
			[
				{
					name: "feeds",
					facet: defineFacet((h) =>
						h.serve(Feed, ({ name }, self) => {
							const next = self.events<string>();
							sources.set(name, next);
							return { next };
						}),
					),
				},
			],
			context,
		);
		const left = await host.get(Feed, { name: "left" }, context),
			right = await host.get(Feed, { name: "right" }, context);
		const stopped = await right.next.on(({ value }) => {
			seen.push(`right:${value}`);
		}, context);
		await left.next.on(({ value }) => {
			seen.push(`left:${value}`);
			if (value === "start") {
				stopped.stop();
				sources.get("left")!.emit("followup");
			}
		}, context);
		const broken = vi.fn(() => {
			throw new Error("subscriber failed");
		});
		await left.next.on(broken, context);
		sources.get("left")!.emit("start");
		sources.get("right")!.emit("cancelled");
		sources.get("left")!.emit("end");
		expect(seen).toEqual([]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(seen).toEqual(["left:start", "left:end", "left:followup"]);
		expect(broken).toHaveBeenCalledTimes(1);
		expect(errors).toEqual([
			expect.objectContaining({
				kind: "listener_error",
				error: expect.objectContaining({ message: "subscriber failed" }),
			}),
		]);
		const cancelled = withCancel(context),
			reason = new Error("already cancelled");
		cancelled.cancel(reason);
		await expect(
			right.next.on(() => {
				throw new Error("unreachable");
			}, cancelled.context),
		).rejects.toBe(reason);
		stopped.stop();
		await right.next.on(({ value }) => {
			seen.push(`new:${value}`);
		}, context);
		sources.get("right")!.emit("available");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(seen.at(-1)).toBe("new:available");
		left.release();
		right.release();
	} finally {
		await host.close(context);
	}
});

test("a subscription follows its reference through reload and ends on cancellation", async () => {
	const Log = local("event-log", { version: 1, params: {}, members: { written: event(str()) } });
	const host = createHost({
		onError(error) {
			throw error;
		},
	});
	const sources: EventSource<string>[] = [];
	const plugin = () => [
		{
			name: "log",
			facet: defineFacet((h) =>
				h.serve(Log, (_, self) => {
					const written = self.events<string>();
					sources.push(written);
					return { written };
				}),
			),
		},
	];
	const lifetime = withCancel(context),
		seen: string[] = [];
	try {
		await host.load(plugin(), context);
		const log = await host.get(Log, {}, context);
		await log.written.on(({ value }) => {
			seen.push(value);
		}, lifetime.context);
		sources[0]!.emit("before");
		expect(seen).toEqual([]);
		await vi.waitFor(() => expect(seen).toEqual(["before"]));
		await host.reload(plugin(), context);
		await vi.waitFor(() => expect(log.state.value.kind).toBe("live"));
		expect(() => sources[0]!.emit("retired")).toThrow(expect.objectContaining({ code: "released" }));
		sources.at(-1)!.emit("after");
		await vi.waitFor(() => expect(seen).toEqual(["before", "after"]));
		lifetime.cancel();
		sources.at(-1)!.emit("cancelled");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(seen).toEqual(["before", "after"]);
		log.release();
	} finally {
		lifetime.cancel();
		await host.close(context);
	}
});

test("remote events retain their emission time and terminal scopes stop listening when disposed", async () => {
	const Address = hostKind("event-server");
	const Log = remote("remote-event-log", {
		version: 1,
		params: {},
		hostAddress: () => Address(),
		variants: { reader: { events: { written: str() }, methods: { write: method(str()) } } },
	});
	const server = createHost({
		address: Address(),
		principal: { kind: "server" },
		onError(error) {
			throw error;
		},
	});
	const client = createHost({
		onError(error) {
			throw error;
		},
	});
	const redraw = vi.fn(),
		scope = new TuiScope(client, redraw);
	try {
		await server.load(
			[
				{
					name: "log",
					facet: defineFacet((h) =>
						h.serve(Log, (_params, _principal, self) => {
							const written = self.events<string>();
							return {
								variant: "reader",
								members: {
									written,
									write: async (value) => {
										written.emit(value);
										return null;
									},
								},
							};
						}),
					),
				},
			],
			context,
		);
		await client.load([], context);
		const [incoming, outgoing] = memoryLinkPair();
		server.accept(incoming, { principal: { kind: "client" } }, context);
		client.connect(outgoing, { principal: { kind: "server" } }, context);
		const log = await client.get(Log, {}, context),
			seen: { value: string; at: number }[] = [];
		scope.on(log.written, (entry) => {
			seen.push(entry);
		});
		const before = Date.now();
		await log.write("one", context);
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual({ value: "one", at: expect.any(Number) });
		expect(seen[0]!.at).toBeGreaterThanOrEqual(before);
		expect(redraw).not.toHaveBeenCalled();
		scope.dispose();
		await log.write("two", context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(seen).toHaveLength(1);
		log.release();
	} finally {
		scope.dispose();
		await client.close(context);
		await server.close(context);
	}
});
