import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxToolCall } from "@axi/ai";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@axi/objects/context";
import { expect, test } from "vitest";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { getOrThrow } from "../src/env/index.ts";
import { AssistantEntry, createRegistry, Harness, MemoryStorage, ToolResultEntry, ToolTask } from "../src/index.ts";
import { createPowerShellTool } from "../src/tools/bash.ts";

test.runIf(process.platform === "win32")(
	"native Windows PowerShell output reaches a durable tool result as UTF-8",
	async () => {
		const env = new NodeExecutionEnv({ cwd: tmpdir() });
		const registry = createRegistry();
		registry.install({ name: "shell", tools: [createPowerShellTool()] });
		const harness = await Harness.open(
			new MemoryStorage(),
			{ registry, models: createModels(), env: () => env },
			context,
		);
		try {
			const root = await harness.root(context);
			const id = await root.commit(async (tx) => {
				const entry = await tx.appendEntry(AssistantEntry, root.id, {
					model: [
						fauxAssistantMessage(
							[fauxToolCall("powershell", { command: "Write-Output 'héllo 日本語'" }, { id: "call" })],
							{ stopReason: "toolUse" },
						),
					],
				});
				return tx.createTask(
					ToolTask,
					{ kind: "model", assistant: entry.id, callId: "call" },
					{ ownership: { kind: "conversation" } },
				);
			}, context);
			harness.resume();
			await harness.waitForTask(id, context);
			const entry = (await root.entries({}, 100, undefined, context)).items.find(ToolResultEntry.is);
			const message = entry?.model?.[0];
			if (message?.role !== "toolResult") throw new Error("Missing PowerShell tool result");
			expect(message.isError).toBe(false);
			expect(message.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")).toContain(
				"héllo 日本語",
			);
		} finally {
			await harness.close(context);
			await env.cleanup(context);
		}
	},
);

test.runIf(process.platform === "win32")(
	"Windows command completion does not wait for an inherited pipe held by a detached child",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-detached-command-"));
		const pidFile = join(directory, "child.pid");
		const env = new NodeExecutionEnv({ cwd: directory });
		const controller = new AbortController();
		const deadline = setTimeout(() => controller.abort(new Error("Command did not settle")), 3000);
		let output = "";
		try {
			const script = `
const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'});
require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
child.unref();
console.log('parent completed');`;
			const result = await env.exec(
				[process.execPath, "-e", script],
				{
					onOutput: (text) => {
						output += text;
					},
				},
				withAbortSignal(controller.signal, context),
			);
			expect(getOrThrow(result).exitCode).toBe(0);
			expect(controller.signal.aborted).toBe(false);
			expect(output).toContain("parent completed");
		} finally {
			clearTimeout(deadline);
			controller.abort();
			await env.cleanup(context);
			try {
				const pid = Number(await readFile(pidFile, "utf8"));
				if (Number.isInteger(pid) && pid > 1) process.kill(pid, "SIGKILL");
			} catch {}
			await rm(directory, { recursive: true, force: true });
		}
	},
);
