import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../src/context/index.ts";
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
