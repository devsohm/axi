import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@axi/ai";
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@axi/codemode";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import { createCodemodeExtension } from "../src/codemode/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { createRegistry, Harness, MemoryStorage, ToolResultEntry } from "../src/index.ts";
import { createReadTool } from "../src/tools/read.ts";

test.each([false, true])("script images share one saved file, including truncated output=%s", async (truncated) => {
	const directory = await mkdtemp(join(tmpdir(), "axi-script-files-"));
	const env = new NodeExecutionEnv({ cwd: directory });
	env.createTempDir = async () => ({ ok: true, value: await mkdtemp(join(directory, "output-")) });
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNQDmj6/2yB0X8AEjMErHEE6yoAAAAASUVORK5CYII=",
		"base64",
	);
	const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
	let harness: Harness | undefined;
	try {
		await writeFile(join(directory, "picture.png"), png);
		const models = createModels(),
			provider = fauxProvider(),
			registry = createRegistry();
		models.setProvider(provider.provider);
		registry.install(createCodemodeExtension({ sandbox, models: false }));
		registry.install({ name: "files", tools: [createReadTool()] });
		harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => env }, context);
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const code = `${truncated ? '// @options: {"max_output_tokens": 30}\n' : ""}
const picture = await tools.read({path: "picture.png"});
text("before"); image(picture); text("between"); image(picture);
console.log("script log");
${truncated ? 'text("complete payload " + "abcdef".repeat(200));' : ""}
return {saved: 2};`;
		provider.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "show-pictures" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Finished"),
		]);
		expect(
			await (await conversation.submit({ type: "input", content: "Read and show the picture twice" }, context)).wait(
				context,
			),
		).toMatchObject({ status: "done" });
		await harness.waitForIdle(context);
		const message = (await conversation.entries({}, 100, undefined, context)).items
			.filter(ToolResultEntry.is)
			.flatMap((entry) => entry.model ?? [])
			.find((entry) => entry.role === "toolResult" && entry.toolCallId === "show-pictures");
		if (message?.role !== "toolResult") throw new Error("Missing script result");
		expect(message.isError).toBe(false);
		const text = message.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
		const paths = [...text.matchAll(/\[Image saved to (.+?) \(image\/png, \d+ bytes\)\]/g)].map((match) => match[1]);
		expect(paths).toHaveLength(2);
		const path = paths[0];
		if (path === undefined) throw new Error("Missing saved image path");
		expect(paths[1]).toBe(path);
		expect(resolve(path)).toBe(join(dirname(path), "image-1.png"));
		expect(await readFile(path)).toEqual(Buffer.from(png));
		expect(message.content.filter((item) => item.type === "image")).toEqual([
			{ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
			{ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
		]);
		expect(message.details).toMatchObject({ calls: [{ name: "read", status: "ok" }] });
		expect((await readdir(dirname(path))).sort()).toEqual(truncated ? ["image-1.png", "output.txt"] : ["image-1.png"]);
		if (truncated) {
			const fullOutputPath = join(dirname(path), "output.txt");
			const details = message.details;
			if (
				!details ||
				typeof details !== "object" ||
				!("fullOutputPath" in details) ||
				typeof details.fullOutputPath !== "string"
			)
				throw new Error("Missing full output path");
			expect(resolve(details.fullOutputPath)).toBe(fullOutputPath);
			expect(text).toContain("truncated output");
			const full = await readFile(fullOutputPath, "utf8");
			expect(full).toContain("complete payload " + "abcdef".repeat(200));
			expect(full).toContain("<console_output>\nscript log\n</console_output>");
			expect(full).toContain('{"saved":2}');
		} else {
			expect(message.details).not.toHaveProperty("fullOutputPath");
			expect(text).toContain("between");
			expect(text).toContain("<console_output>\nscript log\n</console_output>");
		}
	} finally {
		await harness?.close(context);
		await sandbox.close();
		await env.cleanup(context);
		await rm(directory, { recursive: true, force: true });
	}
});
