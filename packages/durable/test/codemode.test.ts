import { createModels, createProvider, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { CodemodeSandbox } from "@axi/codemode";
import { expect, it } from "vitest";
import { CodemodeStoreDoc, createCodemodeExtension } from "../src/codemode/index.ts";
import { createRegistry, Harness, MemoryStorage, ToolResultEntry } from "../src/index.ts";

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
										return {
											taskId: api.taskId,
											isError: false,
											diagnostics: [],
											structuredOutput: { stopReason: "stop", answers: {} },
										};
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
