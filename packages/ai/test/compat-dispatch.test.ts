import { afterEach, expect, test } from "vitest";
import {
	complete,
	completeSimple,
	getApiProvider,
	getApiProviders,
	getModels,
	registerApiProvider,
	registerBuiltInApiProviders,
	registerFauxProvider,
	resetApiProviders,
	stream,
	streamSimple,
	unregisterApiProviders,
} from "../src/compat.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

afterEach(() => resetApiProviders());
const context = normalizeContext({
	messages: [{ role: "user", content: "Answer through the public dispatcher", timestamp: 1 }],
});

test("registered providers support every completion entry point and become unavailable after unregistering", async () => {
	const provider = registerFauxProvider({ api: "owned-dispatch" });
	provider.setResponses(
		["complete", "completeSimple", "stream", "streamSimple"].map((text) => fauxAssistantMessage(text)),
	);
	const model = provider.getModel();
	const answers = [
		await complete(model, context),
		await completeSimple(model, context),
		await stream(model, context).result(),
		await streamSimple(model, context).result(),
	];
	expect(answers.map((answer) => answer.content)).toEqual(
		["complete", "completeSimple", "stream", "streamSimple"].map((text) => [{ type: "text", text }]),
	);
	expect(provider.state.callCount).toBe(4);
	expect(getApiProviders().some((entry) => entry.api === "owned-dispatch")).toBe(true);
	const selected = getApiProvider("owned-dispatch");
	if (!selected) throw new Error("Missing registered provider");
	expect(() => selected.stream({ ...model, api: "different" }, context)).toThrow(/Mismatched api/);
	expect(() => selected.streamSimple({ ...model, api: "different" }, context)).toThrow(/Mismatched api/);
	provider.unregister();
	provider.unregister();
	expect(getApiProvider("owned-dispatch")).toBeUndefined();
	await expect(complete(model, context)).rejects.toThrow(/No API provider registered/);
	await expect(completeSimple(model, context)).rejects.toThrow(/No API provider registered/);
});

test("dispatch resolves synthetic environment credentials while preserving explicit keys", async () => {
	const provider = registerFauxProvider({ api: "owned-credentials", provider: "openai" }),
		seen: (string | undefined)[] = [];
	provider.setResponses(
		Array.from({ length: 4 }, () => (_context, options) => {
			seen.push(options?.apiKey);
			return fauxAssistantMessage("accepted");
		}),
	);
	const model = provider.getModel();
	await complete(model, context, { env: { OPENAI_API_KEY: "environment" } });
	await completeSimple(model, context, { env: { OPENAI_API_KEY: "environment" }, apiKey: "explicit" });
	await stream(model, context, { env: {} }).result();
	await streamSimple(model, context, { env: { OPENAI_API_KEY: "environment" }, apiKey: " " }).result();
	expect(seen).toEqual(["environment", "explicit", undefined, "environment"]);
});

test("removing an old registration source leaves its replacement installed", () => {
	const provider = registerFauxProvider({ api: "owned-replacement" });
	const selected = getApiProvider(provider.api);
	if (!selected) throw new Error("Missing initial provider");
	registerApiProvider(
		{ api: provider.api, stream: selected.stream, streamSimple: selected.streamSimple },
		"replacement",
	);
	provider.unregister();
	expect(getApiProvider(provider.api)).toBeDefined();
	unregisterApiProviders("replacement");
	expect(getApiProvider(provider.api)).toBeUndefined();
	registerBuiltInApiProviders();
	registerBuiltInApiProviders();
	const apis = getApiProviders().map((entry) => entry.api);
	expect(apis).toContain("openai-responses");
	expect(apis).toContain("anthropic-messages");
	expect(new Set(apis).size).toBe(apis.length);
});

test("built-in dispatch uses the selected provider and forwards the synthetic credential to its request", async () => {
	const model = getModels("openai").find((entry) => entry.api === "openai-responses");
	if (!model) throw new Error("No built-in Responses model");
	const authorizations: (string | null)[] = [];
	const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return new Response(
			`data: ${JSON.stringify({ type: "response.completed", response: { id: "owned-response", status: "completed", usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } })}\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		);
	};
	for (const result of [
		await complete(model, context, { apiKey: "synthetic-key", fetch }),
		await completeSimple(model, context, { env: { OPENAI_API_KEY: "synthetic-key" }, fetch }),
	])
		expect(result).toMatchObject({ stopReason: "stop", responseId: "owned-response" });
	expect(authorizations).toEqual(["Bearer synthetic-key", "Bearer synthetic-key"]);
});
