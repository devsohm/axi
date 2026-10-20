import { createModels, createProvider, fauxAssistantMessage, fauxProvider, fauxToolCall, type Usage } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { CodemodeSandbox } from "@axi/codemode";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { createCodemodeExtension } from "../src/codemode/index.ts";
import { createRegistry, defineTool, Harness, MemoryStorage, ToolResultEntry, UsageDoc } from "../src/index.ts";

const usage: Usage = {
	input: 6,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 8,
	cost: { input: 0.02, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.05 },
};
async function scripts(paused = false) {
	const gate = Promise.withResolvers<void>(),
		four = Promise.withResolvers<void>();
	if (!paused) gate.resolve();
	let active = 0,
		peak = 0;
	const sandbox = new CodemodeSandbox(),
		models = createModels(),
		chat = fauxProvider(),
		registry = createRegistry();
	models.setProvider(chat.provider);
	models.setProvider(
		createProvider({
			id: "local-services",
			auth: { apiKey: { name: "Local fixture", resolve: async () => ({ auth: {} }) } },
			models: [
				{
					type: "classifier",
					id: "review",
					name: "Review",
					provider: "local-services",
					api: "local-review",
					baseUrl: "https://local.invalid",
					headers: { authorization: "test-secret" },
					input: ["text", "image"],
					contextWindow: 512,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
				{
					type: "image",
					id: "sketch",
					name: "Sketch",
					provider: "local-services",
					api: "local-sketch",
					baseUrl: "https://local.invalid",
					input: ["text", "image"],
					output: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
			classifiers: {
				"local-review": {
					async classify(model, input) {
						active++;
						peak = Math.max(peak, active);
						if (active === 4) four.resolve();
						await gate.promise;
						active--;
						return {
							api: model.api,
							provider: model.provider,
							model: model.id,
							timestamp: 0,
							answers: { accepted: { type: "bool", probability: input.state.reject === true ? 0 : 1 } },
							stopReason: input.state.reject === true ? "error" : "stop",
							...(input.state.reject === true ? { errorMessage: "Review unavailable" } : {}),
							usage,
						};
					},
				},
			},
			images: {
				"local-sketch": {
					async generateImages(model, input) {
						return {
							api: model.api,
							provider: model.provider,
							model: model.id,
							timestamp: 0,
							stopReason: "stop",
							output: input.input.filter((block) => block.type === "text"),
							usage,
						};
					},
				},
			},
		}),
	);
	registry.install(
		createCodemodeExtension({
			sandbox,
			namespaces: [{ name: "weather", prefix: "weather_", description: "Local forecasts" }],
			globals: [
				{
					name: "lookup",
					async execute(args) {
						if (typeof args !== "string") throw new Error("Expected a region name");
						if (args === "fail") throw new Error("Lookup unavailable");
						return { region: args };
					},
				},
			],
		}),
	);
	registry.install({
		name: "forecast",
		tools: [
			defineTool({
				name: "weather_daily",
				description: "Daily forecast for a location",
				parameters: Type.Object({}),
				deferred: true,
				async execute() {
					return { output: [{ type: "text", text: "sunny" }] };
				},
			}),
			defineTool({
				name: "failed_text",
				description: "Failed plain result",
				parameters: Type.Object({}),
				async execute() {
					return { output: [{ type: "text", text: "Station offline" }], isError: true };
				},
			}),
			defineTool({
				name: "failed_record",
				description: "Failed structured result",
				parameters: Type.Object({}),
				structuredOutputSchema: Type.Object({ reason: Type.String() }),
				async execute() {
					return { output: [], structuredOutput: { reason: "offline" }, isError: true };
				},
			}),
		],
	});
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	let next = 0;
	return {
		harness,
		root,
		four: four.promise,
		release: () => gate.resolve(),
		get concurrency() {
			return { active, peak };
		},
		async run(code: string) {
			const id = `service-${++next}`;
			chat.setResponses([
				fauxAssistantMessage([fauxToolCall("codemode", { code }, { id })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Finished"),
			]);
			expect(
				(await (await root.submit({ type: "input", content: "Run the local script" }, context)).wait(context)).status,
			).toBe("done");
			const entries = (await root.entries({}, 100, undefined, context)).items.filter(ToolResultEntry.is);
			for (const entry of entries) {
				const result = entry.model?.find((message) => message.role === "toolResult" && message.toolCallId === id);
				if (result?.role === "toolResult")
					return {
						result,
						text: result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
					};
			}
			throw new Error("Script result missing");
		},
		async [Symbol.asyncDispose]() {
			gate.resolve();
			await harness.close(context);
			await sandbox.close();
		},
	};
}

test("scripts discover and invoke a deferred namespaced tool", async () => {
	await using f = await scripts();
	const { result, text } = await f.run(
		`return { found: (await searchTools("forecast", {namespace: "weather", limit: 1})).map(t => t.name), description: (await describeNamespace("weather")).description, output: await tools.weather_daily({}), missing: (await describeTool("absent")) ?? null, listed: ALL_TOOLS.some(t => t.name === "weather_daily") };`,
	);
	expect(result.isError).toBe(false);
	expect(text).toContain(
		'{"found":["weather_daily"],"description":"Local forecasts","output":"sunny","missing":null,"listed":true}',
	);
});

test("script discovery validates arguments and keeps missing namespaces absent", async () => {
	await using f = await scripts();
	const { text } = await f.run(
		`const messages = []; for (const action of [() => searchTools(7), () => searchTools("x", {limit: 0}), () => searchTools("x", {namespace: 3}), () => describeTool(false), () => describeNamespace(5)]) { try {await action();} catch(e) {messages.push(e.message);} } return {messages, missing: (await describeNamespace("absent")) ?? null};`,
	);
	expect(text).toContain(
		JSON.stringify({
			messages: [
				"searchTools() expects a query string",
				"searchTools() limit must be a positive integer",
				"searchTools() namespace must be a string",
				"describeTool() expects a tool name",
				"describeNamespace() expects a namespace name",
			],
			missing: null,
		}),
	);
});

test("scripts receive structured tool errors as data and plain failures as exceptions", async () => {
	await using f = await scripts();
	const { result, text } = await f.run(
		`const record = await tools.failed_record({}); let message; try {await tools.failed_text({});} catch(e) {message=e.message;} return {record, message};`,
	);
	expect(result.isError).toBe(false);
	expect(text).toContain('{"record":{"reason":"offline"},"message":"Station offline"}');
	const failed = await f.run('await tools.weather_daily({}); throw new Error("Stopped after effect");');
	expect(failed.result.isError).toBe(true);
	expect(failed.text).toContain("Error: Stopped after effect");
	expect(failed.text).toContain("weather_daily (ok)");
});

test("model catalogs are available in scripts without exposing configured credentials", async () => {
	await using f = await scripts();
	const { text } = await f.run(
		`const all = await models.getModelsOfType("classifier", "local-services"); const available = await models.getAvailableOfType("classifier", "local-services"); const chosen = await models.getModelOfType("classifier", "local-services", "review"); return {ids: all.map(m=>m.id), authenticated: available.map(m=>m.id), selected: chosen.id, headers: Object.hasOwn(chosen,"headers"), missing: (await models.getModelOfType("classifier", "local-services", "missing")) ?? null};`,
	);
	expect(text).toContain(
		'{"ids":["review"],"authenticated":["review"],"selected":"review","headers":false,"missing":null}',
	);
	expect(text).not.toContain("test-secret");
});

test("classifier calls produce structured answers and durable usage on success and failure", async () => {
	await using f = await scripts();
	for (const reject of [false, true]) {
		const { text } = await f.run(
			`const result = await models.classify({provider:"local-services", id:"review"}, {state:{reject:${reject}}, questions:{accepted:{type:"bool",instructions:"Check",criteria:{true:"accepted",false:"rejected"}}}}); return {stop: result.stopReason, answer: result.answers.accepted, cost: result.usage.cost.total};`,
		);
		expect(text).toContain(
			JSON.stringify({
				stop: reject ? "error" : "stop",
				answer: { type: "bool", probability: reject ? 0 : 1 },
				cost: 0.05,
			}),
		);
	}
	const totals = await f.harness.snapshot(UsageDoc, f.root.id, context);
	expect(totals?.tools["axi.codemode.models.classify"]).toMatchObject({
		input: 12,
		output: 4,
		totalTokens: 16,
		cost: { total: 0.1 },
	});
});

test("model and context mistakes return actionable script errors without invoking providers", async () => {
	await using f = await scripts();
	const { text } = await f.run(
		`const errors=[]; const candidate={provider:"local-services",id:"review"}; for(const action of [() => models.getModelsOfType("audio"), () => models.getModelsOfType("chat", 7), () => models.getModelOfType("chat"), () => models.classify(null, {}), () => models.classify({provider:"local-services", id:"missing"}, {}), () => models.classify(candidate, {state:{},questions:{}}), () => models.generateImages(candidate, {input:[{type:"text",text:"paint"}]})]) {try {await action();} catch(e) {errors.push(e.message);}} return errors;`,
	);
	for (const expected of [
		"Unknown model type",
		"provider must be a string",
		"expects three strings",
		"expects a classifier model",
		"Unknown classifier model",
		"context.questions must map question IDs",
		"is a classifier model, not an image model",
	])
		expect(text).toContain(expected);
});

test("custom globals return values and rejected globals become catchable errors", async () => {
	await using f = await scripts();
	const { text, result } = await f.run(
		`const value = await lookup("north"); let failure; try {await lookup("fail");} catch(e) {failure=e.message;} return {value,failure};`,
	);
	expect(result.isError).toBe(false);
	expect(text).toContain('{"value":{"region":"north"},"failure":"Lookup unavailable"}');
});

test("queued classifier calls respect the four-call limit and account for every completed request", async () => {
	await using f = await scripts(true);
	const pending = f.run(
		`const replies = await Promise.all(Array.from({length:9}, () => models.classify({provider:"local-services",id:"review"}, {state:{},questions:{accepted:{type:"bool",instructions:"Check",criteria:{true:"yes",false:"no"}}}}))); return replies.map(r => r.answers.accepted.probability);`,
	);
	try {
		await f.four;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(f.concurrency).toEqual({ active: 4, peak: 4 });
	} finally {
		f.release();
	}
	const { text, result } = await pending;
	expect(result.isError).toBe(false);
	expect(text).toContain("[1,1,1,1,1,1,1,1,1]");
	expect(f.concurrency).toEqual({ active: 0, peak: 4 });
	expect((await f.harness.snapshot(UsageDoc, f.root.id, context))?.tools["axi.codemode.models.classify"]).toMatchObject(
		{ input: 54, output: 18, totalTokens: 72 },
	);
});

test("image model calls pass text and reference blocks and retain their billed usage", async () => {
	await using f = await scripts();
	const { text, result } = await f.run(
		`const result = await models.generateImages({provider:"local-services",id:"sketch"},{input:[{type:"text",text:"A blue square"},{type:"image",data:"AA==",mimeType:"image/png"}]}); return {output:result.output, stop:result.stopReason};`,
	);
	expect(result.isError).toBe(false);
	expect(text).toContain('{"output":[{"type":"text","text":"A blue square"}],"stop":"stop"}');
	expect((await f.harness.snapshot(UsageDoc, f.root.id, context))?.tools["axi.codemode.models.generateImages"]).toEqual(
		usage,
	);
	const invalid = await f.run(
		`const errors=[]; for(const input of [null, {input:[]}, {input:[{type:"image",data:7,mimeType:"image/png"}]}]) {try {await models.generateImages({provider:"local-services",id:"sketch"},input);} catch(e) {errors.push(e.message);}} return errors;`,
	);
	for (const message of [
		"expects a context object",
		"context.input must be a non-empty array",
		"context.input[0] must be a text or image block",
	])
		expect(invalid.text).toContain(message);
	expect((await f.harness.snapshot(UsageDoc, f.root.id, context))?.tools["axi.codemode.models.generateImages"]).toEqual(
		usage,
	);
});

test("classifier validation identifies malformed state, images and each question kind", async () => {
	await using f = await scripts();
	const { text } = await f.run(
		`const valid={type:"bool",instructions:"Check",criteria:{true:"yes",false:"no"}}; const errors=[]; for (const input of [null, {state:[]}, {state:{}, images:3}, {state:{}, images:[{}]}, {state:{},questions:{q:3}}, {state:{},questions:{q:{type:"choice",instructions:"Check",criteria:{}}}}, {state:{},questions:{q:{type:"score",instructions:"Check",criteria:[]}}}, {state:{},questions:{q:{type:"bool",instructions:"Check",criteria:{true:"yes"}}}}, {state:{},questions:{q:{...valid,type:"other"}}}]) {try {await models.classify({provider:"local-services",id:"review"}, input);} catch(e) {errors.push(e.message);}} return errors;`,
	);
	for (const expected of [
		"expects a context object",
		"context.state must be an object",
		"context.images must be an array",
		"context.images[0] must be an image block",
		"context.questions.q must be a question object",
		"criteria must map each label to its meaning",
		"criteria must list the levels as strings, lowest first",
		"criteria must be { true: string, false: string }",
		"context.questions.q.type",
	])
		expect(text).toContain(expected);
	const valid = await f.run(
		`return (await models.classify({provider:"local-services",id:"review"}, {state:{},images:[{type:"image",data:"AA==",mimeType:"image/png"}],questions:{a:{type:"choice",instructions:"Choose",criteria:{a:"A"}},b:{type:"score",instructions:"Rate",criteria:["low","high"]},c:{type:"bool",instructions:"Check",criteria:{true:"yes",false:"no"}}}})).answers;`,
	);
	expect(valid.result.isError).toBe(false);
	expect(valid.text).toContain('{"accepted":{"type":"bool","probability":1}}');
});
