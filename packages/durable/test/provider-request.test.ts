import { createModels, fauxAssistantMessage, fauxProvider } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import {
	createRegistry,
	defineExtension,
	GenerationTask,
	Harness,
	hook,
	MemoryStorage,
	type Report,
} from "@axi/durable";
import { expect, test } from "vitest";

test.each([false, true])("provider body hooks survive resends and retries (throwing observer: %s)", async (throws) => {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	const sent: unknown[] = [],
		observed: unknown[] = [],
		reports: Report[] = [];
	let attempts = 0;
	registry.install(
		defineExtension({
			name: "request-start",
			hooks: [
				hook(GenerationTask, {
					beforeRequest: () => {
						attempts++;
						return undefined;
					},
					beforeProviderRequest: ({ model, payload }) => {
						observed.push([model.id, payload]);
						return { payload: { before: payload } };
					},
				}),
			],
		}),
	);
	registry.install(
		defineExtension({
			name: "request-observer",
			hooks: [
				hook(GenerationTask, {
					beforeProviderRequest: ({ payload }) => {
						observed.push(payload);
						if (throws) throw new Error("observer failed");
						return undefined;
					},
				}),
			],
		}),
	);
	registry.install(
		defineExtension({
			name: "request-end",
			hooks: [
				hook(GenerationTask, {
					beforeProviderRequest: async ({ payload }) => ({ payload: { after: payload } }),
				}),
			],
		}),
	);
	provider.setResponses([
		async (_messages, options, _state, model) => {
			const send = options?.onPayload;
			if (!send) throw new Error("Provider request callback is missing");
			sent.push(await send("first-body", model), await send("resend-body", model));
			return fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 temporarily unavailable" });
		},
		async (_messages, options, _state, model) => {
			const send = options?.onPayload;
			if (!send) throw new Error("Provider request callback is missing");
			sent.push(await send("retry-body", model));
			return fauxAssistantMessage("complete");
		},
	]);
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models,
			registry,
			settings: { retry: { maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } },
			onReport: (report) => reports.push(report),
		},
		context,
	);
	try {
		const model = provider.getModel();
		const conversation = await harness.root(context, {
			agent: { model: { provider: model.provider, modelId: model.id } },
		});
		expect(
			await (await conversation.submit({ type: "input", content: "request" }, context)).wait(context),
		).toMatchObject({ status: "done" });
		expect(attempts).toBe(2);
		expect(sent).toEqual(["first-body", "resend-body", "retry-body"].map((body) => ({ after: { before: body } })));
		expect(observed).toEqual(
			["first-body", "resend-body", "retry-body"].flatMap((body) => [[model.id, body], { before: body }]),
		);
		expect(reports.filter((report) => report.kind === "extension_error").map((report) => report.extension)).toEqual(
			throws ? ["request-observer", "request-observer", "request-observer"] : [],
		);
	} finally {
		await harness.close(context);
	}
});
