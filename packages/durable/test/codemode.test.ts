import { createModels, createProvider, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { CodemodeSandbox } from "@axi/codemode";
import { expect, it } from "vitest";
import { Type } from "typebox";
import { CodemodeStoreDoc, createCodemodeExtension } from "../src/codemode/index.ts";
import { catalogCall } from "../src/codemode/models.ts";
import { createRegistry, defineTool, Harness, MemoryStorage, ToolResultEntry } from "../src/index.ts";

it("lists model metadata without evaluating non-enumerable credential headers", async () => {
	const models = createModels(),
		provider = fauxProvider();
	const model = provider.getModel();
	let reads = 0;
	Object.defineProperty(model, "headers", {
		get() {
			reads++;
			return { Authorization: "private" };
		},
	});
	models.setProvider(provider.provider);
	for (const name of ["models.getModelsOfType", "models.getAvailableOfType", "models.getModelOfType"]) {
		const value = await catalogCall(name, ["chat", model.provider, model.id], models, context);
		const items = Array.isArray(value) ? value : [value];
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ id: model.id });
		expect(items[0]).not.toHaveProperty("headers");
	}
	expect(reads).toBe(0);
});

it("commits successful script state and discards writes from a failed script", async () => {
	const sandbox = new CodemodeSandbox();
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(createCodemodeExtension({ sandbox, models: false }));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const scripts = [
			'store("count", 7); return "saved";',
			'store("count", 99); throw new Error("rejected");',
			'return load("count");',
		];
		for (const [index, code] of scripts.entries()) {
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: `script-${index}` })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([fauxText("done")]),
			]);
			expect((await (await root.submit({ type: "input", content: "run" }, context)).wait(context)).status).toBe("done");
			expect((await harness.snapshot(CodemodeStoreDoc, root.id, context))?.values).toEqual({ count: 7 });
		}
		const results = (await root.entries({}, 100, undefined, context)).items.filter(ToolResultEntry.is).reverse();
		expect(
			results.map((entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].isError),
			JSON.stringify(results),
		).toEqual([false, true, false]);
		const last = results.at(-1)?.model?.[0];
		expect(last?.role === "toolResult" ? last.content : []).toContainEqual({ type: "text", text: "7" });
	} finally {
		await harness.close(context);
		await sandbox.close();
	}
});

it("keeps bounded call previews after a script catches a large tool error", async () => {
	const sandbox = new CodemodeSandbox(),
		models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	registry.install(createCodemodeExtension({ sandbox, models: false }));
	let argumentLength = 0;
	registry.install({
		name: "errors",
		tools: [
			defineTool({
				name: "problem",
				description: "Return the argument as an error",
				parameters: Type.Object({ value: Type.String() }),
				async execute({ value }) {
					argumentLength = value.length;
					return { isError: true, diagnostics: [{ severity: "error", message: value }] };
				},
			}),
		],
	});
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		provider.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: 'try { await tools.problem({ value: "🧪".repeat(2000) }); } catch {} return "recovered";',
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		expect(
			(await (await root.submit({ type: "input", content: "Run the script" }, context)).wait(context)).status,
		).toBe("done");
		const entry = (await root.entries({}, 100, undefined, context)).items.find(ToolResultEntry.is);
		const message = entry?.model?.[0];
		if (message?.role !== "toolResult") throw new Error("Missing code result");
		expect(message.isError).toBe(false);
		expect(message.content).toContainEqual({ type: "text", text: "recovered" });
		expect(argumentLength).toBe(4000);
		expect(message.details).toMatchObject({
			calls: [
				{
					name: "problem",
					status: "error",
					args: expect.stringMatching(/^(?=\{"value":"🧪)[\s\S]{197}\.\.\.$/),
					error: expect.stringMatching(/^(?=🧪)[\s\S]{497}\.\.\.$/),
				},
			],
		});
	} finally {
		await harness.close(context);
		await sandbox.close();
	}
});

it("acquires a model slot before admitting its nested call", async () => {
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	const sandbox = new CodemodeSandbox();
	const registry = createRegistry();
	const order: string[] = [];
	const extension = createCodemodeExtension({
		sandbox,
		globals: [
			{
				name: "mark",
				async execute() {
					order.push("global");
					return null;
				},
			},
		],
	});
	registry.install({
		...extension,
		tools: extension.tools?.map((tool) =>
			tool.name === "codemode"
				? {
						...tool,
						execute(args, api, frame) {
							return tool.execute(
								args,
								{
									...api,
									async executeTool() {
										order.push("nested");
										const result = {
											taskId: api.taskId,
											isError: false as const,
											diagnostics: [],
											structuredOutput: { stopReason: "stop", answers: {} },
										};
										return { ...result, result: async () => result };
									},
								},
								frame,
							);
						},
					}
				: tool,
		),
	});
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const code =
			'await Promise.all([models.classify({ provider: "fixture", id: "judge" }, { state: {}, questions: { ok: { type: "bool", instructions: "Check", criteria: { true: "yes", false: "no" } } } }), mark()]); return "done";';
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "call-order" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		expect((await (await root.submit({ type: "input", content: "run" }, context)).wait(context)).status).toBe("done");
		expect(order).toEqual(["global", "nested"]);
	} finally {
		await harness.close(context);
		await sandbox.close();
	}
});

it.each([
	["classify", "judge", "context.state must be an object"],
	["generateImages", "painter", "context.input must be a non-empty array of blocks"],
])("validates %s input before resolving models again", async (method, modelId, expected) => {
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const unavailable = async (): Promise<never> => {
		throw new Error("Unexpected provider call");
	};
	models.setProvider(
		createProvider({
			id: "fixture",
			auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: {} }) } },
			models: [
				{
					type: "classifier",
					id: "judge",
					name: "Judge",
					provider: "fixture",
					api: "fixture",
					baseUrl: "https://fixture.invalid",
					input: ["text"],
					contextWindow: 1000,
					cost,
				},
				{
					type: "image",
					id: "painter",
					name: "Painter",
					provider: "fixture",
					api: "fixture",
					baseUrl: "https://fixture.invalid",
					input: ["text"],
					output: ["image"],
					cost,
				},
			],
			classifiers: { fixture: { classify: unavailable } },
			images: { fixture: { generateImages: unavailable } },
		}),
	);
	const sandbox = new CodemodeSandbox();
	const registry = createRegistry();
	const extension = createCodemodeExtension({ sandbox });
	let reads = 0;
	registry.install({
		...extension,
		tools: extension.tools?.map((tool) =>
			tool.name.endsWith(`.models.${method}`)
				? {
						...tool,
						execute(args, api, frame) {
							return tool.execute(
								args,
								{
									...api,
									get models() {
										if (++reads > 1) throw new Error("Model configuration changed");
										return models;
									},
								},
								frame,
							);
						},
					}
				: tool,
		),
	});
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const code = `try { await models.${method}({ provider: "fixture", id: "${modelId}" }, { prompt: "invalid" }); } catch (error) { return error.message; }`;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "invalid-context" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		expect((await (await root.submit({ type: "input", content: "run" }, context)).wait(context)).status).toBe("done");
		const entry = (await root.entries({}, 100, undefined, context)).items.find(ToolResultEntry.is);
		const message = entry?.model?.[0];
		if (message?.role !== "toolResult") throw new Error("Missing script result");
		const text = message.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
		expect(text).toContain(expected);
		expect(text).not.toContain("Model configuration changed");
		expect(reads).toBe(1);
	} finally {
		await harness.close(context);
		await sandbox.close();
	}
});
