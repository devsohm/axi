import { createModels, fauxAssistantMessage, fauxProvider } from "@axi/ai";
import type { Message, TranscriptContext } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import {
	createRegistry,
	defineExtension,
	GenerationTask,
	Harness,
	hook,
	MemoryStorage,
	UserEntry,
} from "../src/index.ts";

test("request transforms compose without rewriting history and a yield continuation remains in the same submission", async () => {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	let yields = 0;
	const observed: string[] = [],
		requests: (readonly Message[])[] = [];
	const first = defineExtension({
		name: "first",
		hooks: [
			hook(GenerationTask, {
				beforeRequest({ messages }) {
					return { messages: [...messages, { role: "user", content: "private request context", timestamp: 1 }] };
				},
				afterResponse(message) {
					observed.push(message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""));
				},
				onYield() {
					if (yields++ === 0) return { continue: "follow-up work" };
				},
			}),
		],
	});
	const second = defineExtension({
		name: "second",
		hooks: [
			hook(GenerationTask, {
				beforeRequest({ messages }) {
					expect(messages.at(-1)).toMatchObject({ role: "user", content: "private request context" });
					return { messages: [...messages, { role: "user", content: "final request context", timestamp: 2 }] };
				},
				onYield() {
					return undefined;
				},
			}),
		],
	});
	registry.install(first);
	registry.install(second);
	provider.setResponses(
		["first answer", "final answer"].map((answer) => (request: TranscriptContext) => {
			requests.push([...request.messages]);
			expect(request.messages.at(-1)).toMatchObject({ role: "user", content: "final request context" });
			return fauxAssistantMessage(answer);
		}),
	);
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models, registry, settings: { compaction: { enabled: false } } },
		context,
	);
	try {
		const conversation = await harness.root(context, {
			agent: { model: { provider: "faux", modelId: provider.getModel().id } },
		});
		const receipt = await conversation.submit(
			{ type: "input", content: "original request", requestId: "logical-turn" },
			context,
		);
		expect(await receipt.wait(context)).toMatchObject({ status: "done" });
		await harness.waitForIdle(context);
		expect(observed).toEqual(["first answer", "final answer"]);
		expect(requests).toHaveLength(2);
		const users = (await conversation.entries({ order: "ascending" }, 100, undefined, context)).items.filter(
			UserEntry.is,
		);
		expect(users.flatMap((entry) => entry.model ?? []).map((message) => message.content)).toEqual([
			"original request",
			"follow-up work",
		]);
		expect(
			(await conversation.submit({ type: "input", content: "duplicate", requestId: "logical-turn" }, context)).id,
		).toBe(receipt.id);
		expect(provider.state.callCount).toBe(2);
	} finally {
		await harness.close(context);
	}
});
