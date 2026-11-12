import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { createRegistry, Harness, MemoryStorage, ToolResultEntry } from "../src/index.ts";
import { createBashTool } from "../src/tools/bash.ts";

test.each([false, true])(
	"bash retains an overlong final line with trailing newline=%s and saves its full output",
	async (trailingNewline) => {
		const directory = await mkdtemp(join(tmpdir(), "axi-bash-long-line-"));
		const env = new NodeExecutionEnv({ cwd: directory });
		const models = createModels(),
			provider = fauxProvider(),
			registry = createRegistry();
		models.setProvider(provider.provider);
		const payload = `header\n${"m".repeat(219000)}END${trailingNewline ? "\n" : ""}`;
		const bash = createBashTool({
			prepare(execution) {
				execution.env.AXI_TOOL_NODE = process.execPath;
			},
		});
		const results: Awaited<ReturnType<typeof bash.execute>>[] = [];
		const recorded: typeof bash = {
			...bash,
			async execute(args, api, ctx) {
				const result = await bash.execute(args, api, ctx);
				results.push(result);
				return result;
			},
		};
		registry.install({ name: "shell", tools: [recorded] });
		provider.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: '"$AXI_TOOL_NODE" emit.cjs' }, { id: "long-line" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Output inspected"),
		]);
		const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => env }, context);
		try {
			await writeFile(join(directory, "emit.cjs"), `process.stdout.write(${JSON.stringify(payload)});`);
			const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			expect(
				await (await conversation.submit({ type: "input", content: "Inspect the command output" }, context)).wait(
					context,
				),
			).toMatchObject({ status: "done" });
			await conversation.waitForIdle(context);
			expect(results).toHaveLength(1);
			const output = results[0]?.structuredOutput;
			if (
				output === null ||
				typeof output !== "object" ||
				Array.isArray(output) ||
				typeof output.fullOutputPath !== "string" ||
				typeof output.output !== "string"
			)
				throw new Error("The truncated shell result has no retained output and spill path");
			expect(output).toMatchObject({ truncated: true, exitCode: 0 });
			expect(output.output).toBe(
				"m".repeat(51200 - 3 - Number(trailingNewline)) + "END" + (trailingNewline ? "\n" : ""),
			);
			expect(await readFile(output.fullOutputPath, "utf8")).toBe(payload);
			const entries = await conversation.entries({}, 20, undefined, context);
			const result = entries.items
				.filter(ToolResultEntry.is)
				.flatMap((entry) => entry.model ?? [])
				.find((message) => message.role === "toolResult" && message.toolCallId === "long-line");
			expect(result).toMatchObject({
				isError: false,
				content: expect.arrayContaining([{ type: "text", text: output.output }]),
			});
		} finally {
			await harness.close(context);
			await env.cleanup(context);
			await rm(directory, { recursive: true, force: true });
		}
	},
);
