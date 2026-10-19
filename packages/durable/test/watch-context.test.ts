import { createModels } from "@axi/ai";
import { BACKGROUND_CONTEXT as context, type Context } from "@axi/chord/context";
import { expect, it } from "vitest";
import { createRegistry, Harness, MemoryStorage, watchEvents } from "../src/index.ts";

it.each(["conversation", "graph", "events"] as const)(
	"captures the %s watch cancellation signal once after attachment",
	async (kind) => {
		const harness = await Harness.open(
			new MemoryStorage(),
			{ models: createModels(), registry: createRegistry() },
			context,
		);
		try {
			const conversation = await harness.root(context);
			const hold = kind === "graph" ? await harness.taskGraph(context) : await conversation.viewState(context);
			const controller = new AbortController();
			let reads = 0;
			const expectedReads = 2;
			const invocation: Context = {
				get abortSignal() {
					return ++reads <= expectedReads ? controller.signal : undefined;
				},
				telemetry: context.telemetry,
				value: context.value.bind(context),
				toString: () => context.toString(),
			};
			const watch =
				kind === "graph"
					? await harness.watchTaskGraph(invocation)
					: kind === "events"
						? await watchEvents(harness, conversation.id, invocation)
						: await conversation.watch(invocation);
			try {
				expect(reads).toBe(expectedReads);
				controller.abort();
				await expect(watch.closed).resolves.toEqual({ reason: "cancelled" });
			} finally {
				await watch.stop();
				hold.dispose();
			}
		} finally {
			await harness.close(context);
		}
	},
);
