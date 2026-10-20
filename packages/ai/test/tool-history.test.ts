import { Type } from "typebox";
import { expect, test } from "vitest";
import { stream as responses } from "../src/api/openai-responses.ts";
import { stream as codex } from "../src/api/openai-codex-responses.ts";
import { stream as azure } from "../src/api/azure-openai-responses.ts";
import { stream as completions } from "../src/api/openai-completions.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import type { Api, Model, SystemMessage, Tool, TranscriptContext } from "../src/types.ts";
import {
	getCurrentTools,
	hasNonAdditiveToolChanges,
	normalizeContext,
	resolveTranscriptTools,
} from "../src/utils/transcript.ts";

const tool = (name: string, description = name): Tool => ({ name, description, parameters: Type.Object({}) });
const initial: SystemMessage = {
	role: "system",
	content: "Use local tools",
	toolsAdded: [tool("keep"), tool("retire")],
	timestamp: 0,
};
const removal: SystemMessage = { role: "system", content: "", toolsRemoved: [{ name: "retire" }], timestamp: 2 };
const load: SystemMessage = { role: "system", content: "", toolsAdded: [tool("later")], timestamp: 4 };
const transcript = normalizeContext({
	messages: [
		initial,
		{ role: "user", content: "Start", timestamp: 1 },
		removal,
		{ role: "user", content: "Continue", timestamp: 3 },
		load,
	],
});
function model<A extends Api>(api: A): Model<A> {
	return {
		api,
		id: "history-model",
		provider: "fixture",
		name: "History fixture",
		baseUrl: "https://local.invalid/v1",
		reasoning: true,
		input: ["text"],
		contextWindow: 10000,
		maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

test("addition-only requests move their tool boundary at removal and redeclaration, then leave later additions anchored", () => {
	const messages = [
		...transcript.messages,
		{ role: "system", content: "", toolsAdded: [tool("retire")], timestamp: 5 },
		{ role: "system", content: "", toolsAdded: [tool("final")], timestamp: 6 },
	] satisfies TranscriptContext["messages"];
	expect(resolveTranscriptTools(transcript.messages, "additions")).toEqual({
		requestTools: [tool("keep")],
		foldedSystemMessages: 2,
	});
	expect(resolveTranscriptTools(messages, "additions")).toEqual({
		requestTools: [tool("keep"), tool("later"), tool("retire")],
		foldedSystemMessages: 4,
	});
	expect(resolveTranscriptTools(messages, "none")).toEqual({
		requestTools: [tool("keep"), tool("later"), tool("retire"), tool("final")],
		foldedSystemMessages: 5,
	});
	expect(resolveTranscriptTools(messages, "changes")).toEqual({ requestTools: [], foldedSystemMessages: 0 });
	expect(hasNonAdditiveToolChanges(messages)).toBe(true);
	expect(hasNonAdditiveToolChanges([initial, load])).toBe(false);
	expect(getCurrentTools(messages).map((t) => t.name)).toEqual(["keep", "later", "retire", "final"]);
});

test("Responses keeps its existing input prefix while tools are removed, added and restored", () => {
	const options = { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true };
	const restoredMessage: SystemMessage = {
		role: "system",
		content: "",
		toolsAdded: [tool("retire", "Restored")],
		timestamp: 5,
	};
	const steps = [
		transcript.messages.slice(0, 2),
		transcript.messages.slice(0, 4),
		transcript.messages,
		[...transcript.messages, restoredMessage],
	];
	const payloads = steps.map((messages) =>
		convertResponsesMessages(model("openai-responses"), normalizeContext({ messages }), new Set(), options),
	);
	for (let i = 1; i < payloads.length; i++) {
		const previous = payloads[i - 1];
		if (!previous) throw new Error("Previous input missing");
		expect(payloads[i]?.slice(0, previous.length)).toEqual(previous);
	}
	expect(payloads[0]?.[0]).toMatchObject({ type: "additional_tools", tools: [{ name: "keep" }, { name: "retire" }] });
	expect(payloads[2]).toContainEqual({
		role: "developer",
		content: expect.stringContaining("Still unavailable: retire."),
	});
	const restored = payloads[3];
	expect(restored?.at(-1)).toMatchObject({
		type: "additional_tools",
		tools: [{ name: "retire", description: "Restored" }],
	});
	expect(restored?.at(-2)).toMatchObject({
		content:
			"This is an incremental tools update. Previously declared tools remain available unless explicitly marked unavailable. A tool declared again here is available again, and its latest definition replaces the earlier one.",
	});
	expect(restored?.at(-2)).not.toHaveProperty("content", expect.stringContaining("Still unavailable"));
});

test("a replacement is declared in place without an unavailable notice for that name", () => {
	const messages = [
		initial,
		{
			role: "system",
			content: "",
			toolsRemoved: [{ name: "keep" }, { name: "retire" }],
			toolsAdded: [tool("keep", "Changed")],
			timestamp: 1,
		},
	] satisfies SystemMessage[];
	const input = convertResponsesMessages(model("openai-responses"), normalizeContext({ messages }), new Set(), {
		supportsMidConvoSystemMessages: true,
		supportsAdditionalTools: true,
	});
	expect(input.at(-2)).toMatchObject({ type: "additional_tools", tools: [{ name: "keep", description: "Changed" }] });
	expect(input.at(-3)).toMatchObject({ content: expect.stringContaining("incremental tools update") });
	expect(input.at(-3)).not.toHaveProperty("content", expect.stringContaining("Still unavailable"));
	expect(input.at(-1)).toEqual({
		role: "developer",
		content: "The following tools are no longer available. Do not call them:\n- retire",
	});
});

for (const api of [
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"openai-completions",
] as const)
	test(`${api} forwards the tool-history strategy into its actual request`, async () => {
		const compat = {
			supportsMidConvoSystemMessages: true,
			supportsAdditionalTools: true,
			supportsMidConvoToolAdditions: true,
		};
		let payload: unknown;
		const options = {
			apiKey: `a.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-fixture" } }))}.b`,
			transport: "sse" as const,
			onPayload(value: unknown) {
				payload = value;
				throw new Error("Captured local payload");
			},
			fetch: async () => {
				throw new Error("Unexpected network call");
			},
		};
		const result = await (api === "openai-responses"
			? responses({ ...model(api), compat }, transcript, options)
			: api === "azure-openai-responses"
				? azure({ ...model(api), compat }, transcript, options)
				: api === "openai-codex-responses"
					? codex({ ...model(api), compat }, transcript, options)
					: completions({ ...model(api), compat }, transcript, options)
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Captured local payload");
		if (api === "openai-completions")
			expect(payload).toMatchObject({
				tools: [{ function: { name: "keep" } }],
				messages: expect.arrayContaining([
					{ role: "system", tools: [{ type: "function", function: expect.objectContaining({ name: "later" }) }] },
				]),
			});
		else {
			expect(payload).not.toHaveProperty("tools");
			expect(payload).toMatchObject({
				input: expect.arrayContaining([
					{
						type: "additional_tools",
						role: "developer",
						tools: expect.arrayContaining([expect.objectContaining({ name: "keep" })]),
					},
					{ type: "additional_tools", role: "developer", tools: [expect.objectContaining({ name: "later" })] },
				]),
			});
		}
	});
