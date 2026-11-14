import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@axi/ai";
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@axi/codemode";
import { BACKGROUND_CONTEXT as context, type Context } from "@axi/objects/context";
import { expect, test } from "vitest";
import { CodemodeStoreDoc, createCodemodeExtension } from "../src/codemode/index.ts";
import { createRegistry, Harness, MemoryStorage, ToolResultEntry } from "../src/index.ts";
import { err, FileError } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";

test.each(["available", "absent", "directory-failure", "write-failure"] as const)(
	"bounded script output handles an %s file destination without losing successful state",
	async (destination) => {
		const cwd = await mkdtemp(join(tmpdir(), "axi-script-output-")),
			directories: string[] = [];
		class Environment extends NodeExecutionEnv {
			override async createTempDir(prefix: string | undefined, frame: Context) {
				if (destination === "directory-failure")
					return err<string, FileError>(new FileError("permission_denied", "Cannot create output directory"));
				const result = await super.createTempDir(prefix, frame);
				if (result.ok) directories.push(result.value);
				return result;
			}
			override async writeFile(path: string, data: string | Uint8Array, frame: Context) {
				return destination === "write-failure"
					? err<void, FileError>(new FileError("permission_denied", "Cannot save output", path))
					: super.writeFile(path, data, frame);
			}
		}
		const env = new Environment({ cwd }),
			sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
		const models = createModels(),
			provider = fauxProvider(),
			registry = createRegistry();
		models.setProvider(provider.provider);
		registry.install(createCodemodeExtension({ sandbox, models: false }));
		provider.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"codemode",
						{
							code: '// @options: {"max_output_tokens":20}\ntext("H".repeat(400)); console.log("console marker"); store("saved",true); return "L".repeat(400);',
						},
						{ id: "bounded-output" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Completed"),
		]);
		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry, ...(destination === "absent" ? {} : { env: () => env }) },
			context,
		);
		try {
			const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			expect(
				await (await conversation.submit({ type: "input", content: "Produce and retain long output" }, context)).wait(
					context,
				),
			).toMatchObject({ status: "done" });
			const entry = (await conversation.entries({}, 100, undefined, context)).items.find(ToolResultEntry.is),
				result = entry?.model?.[0];
			if (result?.role !== "toolResult") throw new Error("Script output was not published");
			expect(result.isError).toBe(false);
			const text = result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
			expect(text).toContain("truncated output");
			expect(text).not.toContain("H".repeat(400));
			expect(text).not.toContain("L".repeat(400));
			if (destination === "available") {
				expect(directories).toHaveLength(1);
				expect(await readdir(directories[0]!)).toEqual(["output.txt"]);
				const saved = await readFile(join(directories[0]!, "output.txt"), "utf8");
				expect(saved).toContain("H".repeat(400));
				expect(saved).toContain("L".repeat(400));
				expect(saved).toContain("console marker");
				const details = result.details;
				if (
					!details ||
					typeof details !== "object" ||
					!("fullOutputPath" in details) ||
					typeof details.fullOutputPath !== "string"
				)
					throw new Error("Missing full output path");
				expect(resolve(details.fullOutputPath)).toBe(join(directories[0]!, "output.txt"));
				expect(text).toContain("Full output:");
			} else {
				expect(result.details).not.toHaveProperty("fullOutputPath");
				expect(text).toContain("Could not save the full output:");
				expect(text).toContain(
					destination === "absent"
						? "no execution environment"
						: destination === "directory-failure"
							? "Cannot create output directory"
							: "Cannot save output",
				);
			}
			expect(await harness.snapshot(CodemodeStoreDoc, conversation.id, context)).toEqual({ values: { saved: true } });
		} finally {
			await harness.close(context);
			await sandbox.close();
			await env.cleanup(context);
			for (const path of directories) await rm(path, { recursive: true, force: true });
			await rm(cwd, { recursive: true, force: true });
		}
	},
);
