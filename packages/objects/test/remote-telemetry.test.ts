import { InMemoryTelemetryContext } from "@axi/telemetry";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT, awaitWithContext, withAbortSignal, withTelemetry } from "../src/context/index.ts";
import {
	binaryCodec,
	createHost,
	defineFacet,
	hostKind,
	int,
	memoryLinkPair,
	method,
	ObjectsError,
	remote,
	textCodec,
} from "../src/index.ts";

test.each([
	{ name: "binary", codec: binaryCodec },
	{ name: "text", codec: textCodec },
])("$name remote calls retain trace ownership and report success, error and cancellation", async ({ codec }) => {
	const clientTelemetry = new InMemoryTelemetryContext();
	const serverTelemetry = new InMemoryTelemetryContext();
	const Address = hostKind("traced.service");
	const Service = remote("traced.calls", {
		version: 1,
		params: {},
		hostAddress: () => Address(),
		variants: {
			ready: {
				methods: {
					double: method(int(), int()),
					deny: method(undefined, int()),
					wait: method(undefined, int()),
				},
			},
		},
	});
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<number>();
	const errors: unknown[] = [];
	const server = createHost({
		address: Address(),
		principal: { kind: "server" },
		telemetry: serverTelemetry,
		onError: (error) => errors.push(error),
	});
	const client = createHost({
		principal: { kind: "client" },
		telemetry: clientTelemetry,
		onError: (error) => errors.push(error),
	});
	try {
		await server.load(
			[
				{
					name: "service",
					facet: defineFacet((facet) =>
						facet.serve(Service, () => ({
							variant: "ready",
							members: {
								double: async (value) => value * 2,
								deny: async () => {
									throw new ObjectsError({ code: "forbidden", message: "Access refused" });
								},
								wait: async (context) => {
									entered.resolve();
									return awaitWithContext(finish.promise, context);
								},
							},
						})),
					),
				},
			],
			BACKGROUND_CONTEXT,
		);
		await client.load([], BACKGROUND_CONTEXT);
		const [incoming, outgoing] = memoryLinkPair();
		server.accept(incoming, { principal: { kind: "client" }, codec }, BACKGROUND_CONTEXT);
		client.connect(outgoing, { principal: { kind: "server" }, codec }, BACKGROUND_CONTEXT);
		await clientTelemetry.startSpan({ name: "caller" }, async (span) => {
			const context = withTelemetry(span, BACKGROUND_CONTEXT);
			const reference = await client.get(Service, {}, context);
			try {
				expect(await reference.double(21, context)).toBe(42);
				await expect(reference.deny(context)).rejects.toMatchObject({ code: "forbidden", message: "Access refused" });
				const controller = new AbortController();
				const pending = reference.wait(withAbortSignal(controller.signal, context));
				await entered.promise;
				controller.abort();
				await expect(pending).rejects.toBe(controller.signal.reason);
			} finally {
				reference.release();
			}
		});
		const calls = clientTelemetry.getSpans().filter((span) => span.name === "objects.call");
		expect(calls.map((span) => [span.attributes.member, span.attributes.outcome])).toEqual([
			["double", "ok"],
			["deny", "error"],
			["wait", "aborted"],
		]);
		expect(calls.every((span) => span.settled && span.parentContext !== null)).toBe(true);
		expect(errors).toEqual([]);
	} finally {
		finish.resolve(0);
		await client.close(BACKGROUND_CONTEXT);
		await server.close(BACKGROUND_CONTEXT);
	}
});
