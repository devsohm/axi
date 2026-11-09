import { expect, test } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import {
	convertMessages,
	getDisabledGoogleThinkingConfig,
	resolveGoogleThinkingLevel,
	requiresToolCallId,
	supportsGoogleStrictToolSampling,
	toGoogleThinkingLevel,
	toGoogleSdkThinkingLevel,
	usesGoogleThinkingLevel,
} from "../src/api/google-shared.ts";

const model: Model<"google-generative-ai"> = {
	api: "google-generative-ai",
	id: "gemini-3-pro",
	name: "Fixture",
	provider: "google",
	baseUrl: "https://fixture.invalid",
	reasoning: true,
	input: ["text", "image"],
	maxTokens: 100,
	contextWindow: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

test.each(["minimal", "low", "medium", "high"] as const)(
	"Google %s levels honor mapped values and SDK wire names",
	(level) => {
		expect(resolveGoogleThinkingLevel(model, level)).toBe(level);
		expect(resolveGoogleThinkingLevel({ ...model, thinkingLevelMap: { [level]: level.toUpperCase() } }, level)).toBe(
			level,
		);
		expect(toGoogleSdkThinkingLevel(toGoogleThinkingLevel(level))).toBe(level.toUpperCase());
	},
);

test("disabled thinking uses zero budget where supported and the minimum mapped level otherwise", () => {
	expect(getDisabledGoogleThinkingConfig({ ...model, id: "gemini-2.5-flash" })).toEqual({ thinkingBudget: 0 });
	expect(getDisabledGoogleThinkingConfig(model)).toEqual({ thinkingBudget: 0 });
	expect(getDisabledGoogleThinkingConfig({ ...model, thinkingLevelMap: { off: null, minimal: "LOW" } })).toEqual({
		thinkingLevel: "LOW",
	});
	expect(() => resolveGoogleThinkingLevel({ ...model, thinkingLevelMap: { low: "UNSUPPORTED" } }, "low")).toThrow(
		"Unsupported Google thinking level mapping",
	);
});

test.each([
	["gemini-2.5-flash", false, false, false],
	["gemini-3-pro", true, true, true],
	["gemini-3.1-flash-lite", true, true, true],
	["gemini-live-4", false, true, true],
	["gemini-10-pro", true, true, true],
	["gemini-flash-latest", true, false, false],
	["gemma-4", true, false, false],
	["claude-model", false, true, false],
	["gpt-oss-fixture", false, true, false],
])("model %s selects the expected Google protocol capabilities", (id, levels, ids, strict) => {
	expect(usesGoogleThinkingLevel({ ...model, id })).toBe(levels);
	expect(requiresToolCallId(id)).toBe(ids);
	expect(supportsGoogleStrictToolSampling(id)).toBe(strict);
});

test("Google transcripts preserve multimodal users and only reusable signed model parts", () => {
	const prior = {
		...fauxAssistantMessage([
			{ type: "text", text: " " },
			{ type: "thinking", thinking: "reason", thinkingSignature: "c2ln" },
			{ type: "text", text: "answer", textSignature: "not base64" },
		]),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
	const context = normalizeContext({
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "inspect" },
					{ type: "image", mimeType: "image/png", data: "AA==" },
				],
				timestamp: 0,
			},
			prior,
		],
	});
	expect(convertMessages(model, context)).toEqual([
		{ role: "user", parts: [{ text: "inspect" }, { inlineData: { mimeType: "image/png", data: "AA==" } }] },
		{ role: "model", parts: [{ text: "reason", thought: true, thoughtSignature: "c2ln" }, { text: "answer" }] },
	]);
	expect(convertMessages({ ...model, id: "different-model" }, normalizeContext({ messages: [prior] }))).toEqual([
		{ role: "model", parts: [{ text: "answer" }] },
	]);
});

test.each(["gemini-2.5-pro", "gemini-3-pro"])(
	"tool image results use the %s image envelope and group adjacent responses",
	(id) => {
		const selected = { ...model, id };
		const prior = {
			...fauxAssistantMessage([
				{ type: "toolCall", id: "one", name: "read", arguments: {} },
				{ type: "toolCall", id: "two", name: "stat", arguments: {} },
			]),
			api: selected.api,
			provider: selected.provider,
			model: selected.id,
		};
		const results = convertMessages(
			selected,
			normalizeContext({
				messages: [
					prior,
					{
						role: "toolResult",
						toolCallId: "one",
						toolName: "read",
						isError: false,
						content: [{ type: "image", mimeType: "image/png", data: "AA==" }],
						timestamp: 1,
					},
					{
						role: "toolResult",
						toolCallId: "two",
						toolName: "stat",
						isError: true,
						content: [
							{ type: "text", text: "missing" },
							{ type: "text", text: "retry" },
						],
						timestamp: 2,
					},
				],
			}),
		);
		const responses = results.flatMap(
			(row) => row.parts?.flatMap((part) => (part.functionResponse ? [part.functionResponse] : [])) ?? [],
		);
		expect(responses).toHaveLength(2);
		expect(responses[0]).toMatchObject({ name: "read", response: { output: "(see attached image)" } });
		expect(responses[1]).toMatchObject({ name: "stat", response: { error: "missing\nretry" } });
		if (id === "gemini-3-pro") {
			expect(responses[0]).toHaveProperty("parts", [{ inlineData: { mimeType: "image/png", data: "AA==" } }]);
			expect(results[1]?.parts).toHaveLength(2);
		} else {
			expect(responses[0]).not.toHaveProperty("parts");
			expect(results[2]?.parts).toContainEqual({ text: "Tool result image:" });
		}
	},
);
