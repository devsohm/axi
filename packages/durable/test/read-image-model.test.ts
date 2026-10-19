import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { expect, it } from "vitest";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { createRegistry, defineExtension, Harness, MemoryStorage, ToolResultEntry } from "../src/index.ts";
import { createReadTool } from "../src/tools/read.ts";

it("keeps the selected model's image capability through asynchronous preparation", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "axi-image-model-"));
	const env = new NodeExecutionEnv({ cwd });
	const faux = fauxProvider({ models: [{ id: "text", input: ["text"] }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = models.getModel(faux.provider.id, "text");
	if (!model) throw new Error("Missing local model");
	const registry = createRegistry();
	registry.install(
		defineExtension({
			name: "files",
			tools: [
				createReadTool({
					images: {
						prepare: async () => {
							await Promise.resolve();
							model.input.push("image");
							return { data: "AQ==", mimeType: "image/png" };
						},
					},
				}),
			],
		}),
	);
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { models, registry, env: () => env }, context);
	try {
		await writeFile(
			join(cwd, "image.png"),
			Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex"),
		);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "image.png" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);
		const conversation = await harness.root(context, {
			agent: { model: { provider: faux.provider.id, modelId: "text" } },
		});
		await (await conversation.submit({ type: "input", content: "Read the image" }, context)).wait(context);
		await harness.waitForIdle(context);
		const entries = await storage.scanEntries({ conversationId: conversation.id }, 100, undefined, context);
		const result = entries.items.find(ToolResultEntry.is);
		expect(result?.data).toMatchObject({
			diagnostics: [
				{
					severity: "info",
					code: "image",
					message:
						"Read image file [image/png]. The current model does not support images; it sees a placeholder instead.",
				},
			],
		});
		expect(model.input).toEqual(["text", "image"]);
	} finally {
		await harness.close(context);
		await env.cleanup(context);
		await rm(cwd, { recursive: true, force: true });
	}
});
