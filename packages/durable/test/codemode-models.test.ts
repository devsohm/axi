import { createModels, createProvider, fauxAssistantMessage, fauxProvider, fauxToolCall, type Provider } from "@axi/ai";
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@axi/codemode";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import { createCodemodeExtension, type CodemodeToolOptions } from "../src/codemode/index.ts";
import { createRegistry, Harness, MemoryStorage, ToolResultEntry, UsageDoc } from "../src/index.ts";

const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
const question = '{state:{},questions:{ok:{type:"bool",instructions:"Check",criteria:{true:"yes",false:"no"}}}}';

async function open(
	classify: NonNullable<Provider["classify"]>,
	globals: CodemodeToolOptions["globals"] = [],
	onFinished: () => void = () => {},
) {
	const models = createModels(),
		chat = fauxProvider(),
		registry = createRegistry();
	models.setProvider(chat.provider);
	const metadata = {
		provider: "local",
		api: "local",
		baseUrl: "https://local.invalid",
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	models.setProvider(
		createProvider({
			id: "local",
			auth: { apiKey: { name: "Local", resolve: async () => ({ auth: {} }) } },
			models: [
				{ ...metadata, type: "classifier", id: "check", name: "Check", contextWindow: 1000 },
				{ ...metadata, type: "image", id: "draw", name: "Draw", output: ["image"] },
			],
			classifiers: { local: { classify } },
			images: {
				local: {
					generateImages: async () => ({
						api: "local",
						provider: "local",
						model: "draw",
						output: [image, image],
						stopReason: "stop",
						timestamp: 0,
					}),
				},
			},
		}),
	);
	class Sandbox extends InlineCodemodeSandbox {
		override start(...args: Parameters<InlineCodemodeSandbox["start"]>) {
			const run = super.start(...args);
			void run.result.then(onFinished);
			return run;
		}
	}
	const sandbox = new Sandbox({ wasm: loadQuickJSWasm() });
	registry.install(createCodemodeExtension({ sandbox, globals }));
	const harness = await Harness.open(new MemoryStorage(), { registry, models }, context);
	const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	let sequence = 0;
	return {
		harness,
		async run(code: string) {
			const id = `script-${++sequence}`;
			chat.setResponses([
				fauxAssistantMessage([fauxToolCall("codemode", { code }, { id })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Finished"),
			]);
			expect((await (await conversation.submit({ type: "input", content: "Run" }, context)).wait(context)).status).toBe(
				"done",
			);
			const message = (await conversation.entries({}, 100, undefined, context)).items
				.filter(ToolResultEntry.is)
				.flatMap((entry) => entry.model ?? [])
				.find((item) => item.role === "toolResult" && item.toolCallId === id);
			if (message?.role !== "toolResult") throw new Error("Missing script result");
			expect(message.isError, JSON.stringify(message.content)).toBe(false);
			return {
				message,
				text: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
				usage: await harness.snapshot(UsageDoc, conversation.id, context),
			};
		},
		async [Symbol.asyncDispose]() {
			await harness.close(context);
			await sandbox.close();
		},
	};
}

test("sandbox model requests share four slots and charge each result once", async () => {
	const gate = Promise.withResolvers<void>();
	const started: number[] = [];
	let active = 0,
		maximum = 0;
	await using app = await open(async (model, request) => {
		started.push(Number(request.state.index));
		maximum = Math.max(maximum, ++active);
		await gate.promise;
		active--;
		return {
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: 0,
			stopReason: "stop",
			answers: { ok: { type: "bool", probability: Number(request.state.index) / 8 } },
			usage: {
				input: 3,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 4,
				cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
			},
		};
	});
	const pending = app.run(
		`const requests=Array.from({length:8},(_,index)=>{const request=${question}; request.state.index=index; return models.classify({provider:"local",id:"check"},request);}); return (await Promise.all(requests)).map(item=>item.answers.ok.probability);`,
	);
	try {
		await expect.poll(() => started.length).toBe(4);
		expect(active).toBe(4);
	} finally {
		gate.resolve();
	}
	const result = await pending;
	const body = result.message.content[1];
	if (body?.type !== "text") throw new Error("Missing return value");
	expect(JSON.parse(body.text)).toEqual([0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]);
	expect(started.toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	expect(maximum).toBe(4);
	expect(result.usage?.tools["axi.codemode.models.classify"]).toMatchObject({ input: 24, output: 8, totalTokens: 32 });
	expect(result.usage?.tools["axi.codemode.models.classify"]?.cost.total).toBeCloseTo(0.08);
});

test("a completed script leaves queued model requests unstarted", async () => {
	const gate = Promise.withResolvers<void>(),
		fourStarted = Promise.withResolvers<void>();
	let starts = 0;
	await using app = await open(
		async (model) => {
			if (++starts === 4) fourStarted.resolve();
			await gate.promise;
			return {
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: 0,
				stopReason: "stop",
				answers: {},
			};
		},
		[
			{
				name: "ready",
				execute: async () => {
					await fourStarted.promise;
					return null;
				},
			},
		],
		() => gate.resolve(),
	);
	try {
		const result = await app.run(
			`for(let i=0;i<7;i++) models.classify({provider:"local",id:"check"},${question}).catch(()=>{}); await ready(); return "complete";`,
		);
		expect(result.text).toContain("complete");
		gate.resolve();
		await app.harness.waitForIdle(context);
		expect(starts).toBe(4);
	} finally {
		gate.resolve();
	}
});

test("model errors remain values, private model tools stay hidden and unused images are reported", async () => {
	await using app = await open(async (model) => ({
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: 0,
		stopReason: "error",
		errorMessage: "Local classifier unavailable",
		answers: {},
	}));
	const result = await app.run(
		`const failure=await models.classify({provider:"local",id:"check"},${question}); await models.generateImages({provider:"local",id:"draw"},{input:[{type:"text",text:"draw"}]}); return {failure, exposed: Object.keys(tools).some(name=>name.includes("models")) || ALL_TOOLS.some(tool=>tool.name.includes("models")), described: (await describeTool("axi.codemode.models.classify")) ?? null, found: (await searchTools("models classify generateImages")).length};`,
	);
	expect(result.text).toContain('"stopReason":"error"');
	expect(result.text).toContain('"errorMessage":"Local classifier unavailable"');
	expect(result.text).toContain('"exposed":false,"described":null,"found":0');
	expect(result.text).toContain("returned 2 images that the script did not show");
	expect(result.message.details).toMatchObject({
		calls: [
			{ name: "models.classify", status: "error" },
			{ name: "models.generateImages", status: "ok" },
		],
	});
	const shown = await app.run(
		'const result=await models.generateImages({provider:"local",id:"draw"},{input:[{type:"text",text:"draw"}]}); image(result.output[0]);',
	);
	expect(shown.message.content).toContainEqual(image);
	expect(shown.text).not.toContain("that the script did not show");
});
