import { expect, test } from "vitest";
import { stream } from "../src/api/openai-responses.ts";
import type { AssistantMessageEvent, Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "stream-fixture",
	name: "Stream fixture",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://provider.invalid/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 500,
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
	compat: { supportsOpenAIGrammarTools: true },
};
const grammar: Tool = {
	name: "source",
	description: "Submit source text",
	parameters: { type: "object", properties: { source: { type: "string" } }, required: ["source"] },
	constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /.+/" } },
};
const context = normalizeContext({
	tools: [grammar],
	messages: [{ role: "user", content: "test input", timestamp: 1 }],
});
const terminal = (status = "completed", extra: object = {}) => ({
	type: "response.completed",
	response: { id: "result", status, ...extra },
});
function run(events: object[]) {
	return stream(model, context, {
		apiKey: "synthetic-test-key",
		maxRetries: 0,
		fetch: async () =>
			new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			}),
	});
}

test.each([false, true])("grammar tool input streams append-only JSON with initial input %s", async (seeded) => {
	const initial = seeded ? 'begin "quoted"' : "",
		suffix = "\n界🙂\\end";
	const item = {
		type: "custom_tool_call",
		id: "ct_1",
		call_id: "call_1",
		name: "source",
		input: initial,
		namespace: "workspace",
	};
	const response = run([
		{ type: "response.output_item.added", output_index: 0, item },
		{ type: "response.custom_tool_call_input.delta", output_index: 0, delta: suffix.slice(0, 3) },
		{ type: "response.custom_tool_call_input.delta", output_index: 0, delta: suffix.slice(3) },
		{ type: "response.custom_tool_call_input.done", output_index: 0, input: initial + suffix },
		{ type: "response.output_item.done", output_index: 0, item: { ...item, input: initial + suffix } },
		terminal(),
	]);
	const events: AssistantMessageEvent[] = [];
	for await (const event of response) events.push(event);
	const result = await response.result();
	expect(result).toMatchObject({
		stopReason: "toolUse",
		content: [
			{
				type: "toolCall",
				id: "call_1|ct_1",
				name: "source",
				namespace: "workspace",
				arguments: { source: initial + suffix },
			},
		],
	});
	const json = events
		.filter((event) => event.type === "toolcall_delta")
		.map((event) => event.delta)
		.join("");
	expect(JSON.parse(json)).toEqual({ source: initial + suffix });
	expect(events.map((event) => event.type)).toEqual([
		"start",
		"toolcall_start",
		"toolcall_delta",
		"toolcall_delta",
		"toolcall_delta",
		"toolcall_end",
		"done",
	]);
});

test("an empty custom tool input is closed into an empty string even without delta events", async () => {
	const item = { type: "custom_tool_call", id: "ct_empty", call_id: "call_empty", name: "unknown", input: "" };
	const result = await run([{ type: "response.output_item.done", output_index: 0, item }, terminal()]).result();
	expect(result).toMatchObject({ stopReason: "toolUse", content: [{ type: "toolCall", arguments: { input: "" } }] });
});

test("a provider cannot rewrite grammar input when completing its streamed call", async () => {
	const item = { type: "custom_tool_call", id: "ct_bad", call_id: "call_bad", name: "source", input: "before" };
	const result = await run([
		{ type: "response.output_item.added", output_index: 0, item },
		{ type: "response.custom_tool_call_input.done", output_index: 0, input: "after" },
		terminal(),
	]).result();
	expect(result).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("non-monotonically") });
});

test("function-call completion backfills arguments and preserves a late namespace", async () => {
	const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "calculate", arguments: '{"count":' };
	const response = run([
		{ type: "response.output_item.added", output_index: 2, item },
		{ type: "response.custom_tool_call_input.delta", output_index: 2, delta: "ignored" },
		{ type: "response.function_call_arguments.done", output_index: 2, arguments: '{"count":3}' },
		{
			type: "response.output_item.done",
			output_index: 2,
			item: { ...item, arguments: '{"count":3}', namespace: "math" },
		},
		terminal(),
	]);
	const result = await response.result();
	expect(result).toMatchObject({
		stopReason: "toolUse",
		content: [{ type: "toolCall", id: "call_1|fc_1", namespace: "math", arguments: { count: 3 } }],
	});
});

test("reasoning text and refusal deltas are finalized from their complete provider items", async () => {
	const reasoning = {
		type: "reasoning",
		id: "reason_1",
		summary: [],
		content: [{ type: "reasoning_text", text: "final analysis" }],
	};
	const message = {
		type: "message",
		id: "message_1",
		role: "assistant",
		status: "completed",
		phase: "final_answer",
		content: [{ type: "refusal", refusal: "Unable to help" }],
	};
	const response = run([
		{ type: "response.reasoning_text.delta", output_index: 9, delta: "unattached" },
		{ type: "response.output_item.added", output_index: 0, item: reasoning },
		{ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "analysis" },
		{ type: "response.reasoning_summary_part.done", output_index: 0 },
		{ type: "response.reasoning_text.delta", output_index: 0, delta: "more" },
		{ type: "response.output_item.done", output_index: 0, item: reasoning },
		{ type: "response.output_item.added", output_index: 1, item: { ...message, content: [] } },
		{ type: "response.refusal.delta", output_index: 1, delta: "Unable" },
		{ type: "response.output_item.done", output_index: 1, item: message },
		terminal("completed", {
			output: [
				{ ...reasoning, encrypted_content: "opaque-state" },
				{ type: "reasoning", id: "not-opened", encrypted_content: "other" },
			],
		}),
	]);
	const events: AssistantMessageEvent[] = [];
	for await (const event of response) events.push(event);
	expect((await response.result()).content).toEqual([
		{
			type: "thinking",
			thinking: "final analysis",
			thinkingSignature: JSON.stringify({ ...reasoning, encrypted_content: "opaque-state" }),
		},
		{
			type: "text",
			text: "Unable to help",
			textSignature: JSON.stringify({ v: 1, id: "message_1", phase: "final_answer" }),
		},
	]);
	expect(events.filter((event) => event.type === "thinking_delta").map((event) => event.delta)).toEqual([
		"analysis",
		"\n\n",
		"more",
	]);
});

test.each(["failed", "cancelled", "queued", "in_progress", "unexpected-status"])(
	"terminal provider status %s is reported without inventing an answer",
	async (status) => {
		const result = await run([terminal(status)]).result();
		expect(result.content).toEqual([]);
		expect(result.stopReason).toBe(status === "queued" || status === "in_progress" ? "stop" : "error");
		if (status === "unexpected-status") expect(result.errorMessage).toContain("Unhandled stop reason");
	},
);

test("token exhaustion remains length-limited and cache counts never make input negative", async () => {
	const result = await run([
		terminal("incomplete", {
			incomplete_details: { reason: "max_output_tokens" },
			usage: {
				input_tokens: 4,
				output_tokens: 9,
				total_tokens: 13,
				input_tokens_details: { cached_tokens: 8, cache_write_tokens: 2 },
			},
		}),
	]).result();
	expect(result).toMatchObject({
		stopReason: "length",
		rawStopReason: "incomplete.max_output_tokens",
		usage: { input: 0, cacheRead: 8, cacheWrite: 2, output: 9 },
	});
});

test.each([
	[{ error: { code: "unavailable", message: "Try later" } }, "unavailable: Try later"],
	[{ incomplete_details: { reason: "capacity" } }, "incomplete: capacity"],
	[{}, "Unknown error (no error details in response)"],
] as const)("failed provider events preserve their available detail: %j", async (details, expected) => {
	const result = await run([{ type: "response.failed", response: { status: "failed", ...details } }]).result();
	expect(result).toMatchObject({ stopReason: "error", rawStopReason: "failed", errorMessage: expected });
});

test("completed responses reject unfinished tools and ignore unrelated output types", async () => {
	const result = await run([
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "web_search_call", id: "search", status: "in_progress" },
		},
		{
			type: "response.output_item.added",
			output_index: 1,
			item: { type: "function_call", id: "fc_missing", call_id: "call_missing", name: "missing", arguments: "" },
		},
		terminal(),
	]).result();
	expect(result).toMatchObject({
		stopReason: "error",
		errorMessage: expect.stringContaining("unfinished tool call: missing"),
		content: [{ type: "toolCall", name: "missing" }],
	});
});
