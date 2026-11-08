import { expect, test } from "vitest";
import { Type } from "typebox";
import {
	convertResponsesMessages,
	convertResponsesTools,
	getResponsesToolSupport,
} from "../src/api/openai-responses-shared.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { AssistantMessage, Model, Tool, ToolResultMessage } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	api: "openai-responses",
	provider: "openai",
	id: "chat",
	name: "Chat",
	baseUrl: "https://provider.example/v1",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 32000,
	maxTokens: 2000,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};
const allowed = new Set([model.provider]);
function assistant(content: AssistantMessage["content"], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return { ...fauxAssistantMessage(content), api: model.api, provider: model.provider, model: model.id, ...overrides };
}
const tool: Tool = {
	name: "execute",
	description: "Execute source",
	parameters: Type.Object({ source: Type.String() }),
};

test("Responses text signatures retain supported phases, tolerate legacy IDs and bound long replay IDs", () => {
	for (const [signature, expected] of [
		[undefined, { id: "msg_axi_0", phase: undefined }],
		["legacy-id", { id: "legacy-id", phase: undefined }],
		['{"v":1,"id":"message","phase":"commentary"}', { id: "message", phase: "commentary" }],
		['{"v":1,"id":"final","phase":"final_answer"}', { id: "final", phase: "final_answer" }],
		['{"v":1,"id":"message","phase":"unknown"}', { id: "message", phase: undefined }],
		["{broken", { id: "{broken", phase: undefined }],
	] satisfies [string | undefined, object][]) {
		const transcript = normalizeContext({
			messages: [assistant([{ type: "text", text: "answer", textSignature: signature }])],
		});
		const before = structuredClone(transcript);
		expect(convertResponsesMessages(model, transcript, allowed)).toEqual([
			expect.objectContaining({ type: "message", ...expected }),
		]);
		expect(transcript).toEqual(before);
	}
	const long = normalizeContext({
		messages: [
			assistant([
				{ type: "text", text: "one", textSignature: "x".repeat(100) },
				{ type: "text", text: "two" },
			]),
		],
	});
	const first = convertResponsesMessages(model, long, allowed);
	expect(first).toEqual(convertResponsesMessages(model, long, allowed));
	expect(first[0]).toMatchObject({ id: expect.stringMatching(/^msg_.{1,60}$/) });
	expect(first[1]).toMatchObject({ id: "msg_axi_0_1" });
});

test("grammar calls keep raw input and namespaces only when the replay model can interpret them", () => {
	const properties = new Map([[tool.name, "source"]]);
	const call = {
		type: "toolCall",
		id: "call|ctc_item",
		name: tool.name,
		namespace: "local",
		arguments: { source: 'echo "hi"\n' },
	} as const;
	const result: ToolResultMessage = {
		role: "toolResult",
		toolName: tool.name,
		toolCallId: call.id,
		isError: false,
		timestamp: 2,
		content: [],
	};
	const transcript = normalizeContext({ messages: [assistant([call]), result] });
	expect(convertResponsesMessages(model, transcript, allowed, { grammarToolInputProperties: properties })).toEqual([
		{
			type: "custom_tool_call",
			id: "ctc_item",
			call_id: "call",
			name: tool.name,
			namespace: "local",
			input: 'echo "hi"\n',
		},
		{ type: "custom_tool_call_output", call_id: "call", output: "(no tool output)" },
	]);
	const changed = convertResponsesMessages({ ...model, id: "other-model" }, transcript, allowed, {
		grammarToolInputProperties: properties,
	});
	expect(changed[0]).toMatchObject({ type: "custom_tool_call", id: undefined });
	expect(changed[0]).not.toHaveProperty("namespace");
	const ordinary = normalizeContext({
		messages: [assistant([{ ...call, id: "call|fc_item" }]), { ...result, toolCallId: "call|fc_item" }],
	});
	expect(convertResponsesMessages(model, ordinary, allowed)[0]).toMatchObject({
		type: "function_call",
		id: "fc_item",
		namespace: "local",
		arguments: JSON.stringify(call.arguments),
	});
});

test("multimodal user and tool results omit empty messages and keep attached images inside the call result", () => {
	const image = { type: "image", data: "AQID", mimeType: "image/png" } as const;
	const result: ToolResultMessage = {
		role: "toolResult",
		toolName: tool.name,
		toolCallId: "call",
		isError: false,
		timestamp: 2,
		content: [image],
	};
	const transcript = normalizeContext({
		messages: [
			{ role: "user", content: [], timestamp: 0 },
			{ role: "user", content: [{ type: "text", text: "inspect" }, image], timestamp: 1 },
			assistant([{ type: "toolCall", id: "call", name: tool.name, arguments: {} }]),
			result,
		],
	});
	const converted = convertResponsesMessages(model, transcript, allowed);
	expect(converted).toHaveLength(3);
	expect(converted[0]).toMatchObject({
		role: "user",
		content: [
			{ type: "input_text", text: "inspect" },
			{ type: "input_image", image_url: "data:image/png;base64,AQID" },
		],
	});
	expect(converted[2]).toMatchObject({
		type: "function_call_output",
		output: [{ type: "input_image", image_url: "data:image/png;base64,AQID" }],
	});
	const textOnly = convertResponsesMessages({ ...model, input: ["text"] }, transcript, allowed);
	expect(JSON.stringify(textOnly)).not.toContain("base64");
	expect(JSON.stringify(textOnly)).toContain("omitted");
});

test("tool search and incremental-tool capabilities select the appropriate wire declaration", () => {
	expect(getResponsesToolSupport({})).toBe("none");
	expect(getResponsesToolSupport({ supportsToolSearch: true })).toBe("additions");
	expect(
		getResponsesToolSupport({
			supportsMidConvoSystemMessages: true,
			supportsAdditionalTools: true,
			supportsToolSearch: true,
		}),
	).toBe("changes");
	const next = { ...tool, name: "later" };
	const transcript = normalizeContext({
		systemPrompt: "Rules",
		tools: [tool],
		messages: [
			{ role: "user", content: "first", timestamp: 1 },
			assistant([{ type: "text", text: "ready" }]),
			{ role: "system", content: "Update", toolsAdded: [next], timestamp: 2 },
			{ role: "user", content: "next", timestamp: 3 },
		],
	});
	const search = convertResponsesMessages(model, transcript, allowed, {
		supportsMidConvoSystemMessages: true,
		supportsToolSearch: true,
	});
	expect(search).toContainEqual(
		expect.objectContaining({ type: "tool_search_call", arguments: { query: "later", limit: 1 } }),
	);
	expect(search).toContainEqual(
		expect.objectContaining({
			type: "tool_search_output",
			tools: [expect.objectContaining({ name: "later", defer_loading: true })],
		}),
	);
	const replacement = normalizeContext({
		messages: [
			...transcript.messages,
			{ role: "system", content: "Remove", toolsRemoved: [{ name: tool.name }], timestamp: 4 },
		],
	});
	expect(
		convertResponsesMessages(model, replacement, allowed, {
			supportsMidConvoSystemMessages: true,
			supportsToolSearch: true,
		}).some((message) => "type" in message && message.type === "tool_search_call"),
	).toBe(false);
	const changes = convertResponsesMessages(model, transcript, allowed, {
		supportsMidConvoSystemMessages: true,
		supportsAdditionalTools: true,
	});
	expect(changes).toContainEqual(
		expect.objectContaining({ type: "additional_tools", tools: [expect.objectContaining({ name: "later" })] }),
	);
	expect(JSON.stringify(changes)).toContain("execute");
	const grammar = {
		...tool,
		constrainedSampling: { type: "grammar", variants: { openai_regex: ".*" } },
	} satisfies Tool;
	expect(convertResponsesTools([grammar], { supportsOpenAIGrammarTools: true, toolSearchResult: true })).toEqual([
		{
			type: "custom",
			name: tool.name,
			description: tool.description,
			format: { type: "grammar", syntax: "regex", definition: ".*" },
			defer_loading: true,
		},
	]);
});

test("thinking configurations follow same-model history and the next request's requested effort", () => {
	const transcript = normalizeContext({
		systemPrompt: "Rules",
		messages: [assistant([{ type: "text", text: "answer" }], { providerThinkingLevel: "low" })],
	});
	const messages = convertResponsesMessages(model, transcript, allowed, { configurationUpdateEffort: "high" });
	expect(messages.filter((message) => "type" in message && message.type === "configuration_update")).toEqual([
		{ type: "configuration_update", reasoning: { effort: "low" } },
		{ type: "configuration_update", reasoning: { effort: "high" } },
	]);
	expect(convertResponsesMessages(model, transcript, allowed, { includeSystemPrompt: false })).toHaveLength(1);
	expect(
		convertResponsesMessages({ ...model, compat: { supportsDeveloperRole: false } }, transcript, allowed)[0],
	).toMatchObject({ role: "system" });
	const foreign = convertResponsesMessages({ ...model, id: "other-model" }, transcript, allowed, {
		configurationUpdateEffort: "high",
	});
	expect(foreign.filter((message) => "type" in message && message.type === "configuration_update")).toEqual([
		{ type: "configuration_update", reasoning: { effort: "high" } },
	]);
});
