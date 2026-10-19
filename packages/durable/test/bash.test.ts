import { createModels, fauxAssistantMessage, fauxToolCall } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { AssistantEntry, createRegistry, Harness, MemoryStorage, ToolTask } from "../src/index.ts";
import { type BashToolInput, createBashTool, createPowerShellTool } from "../src/tools/bash.ts";

it("keeps the shell program list selected when the tool is created", async () => {
	const env = new NodeExecutionEnv({ cwd: process.cwd() });
	const exec = vi.spyOn(env, "exec").mockResolvedValue({ ok: true, value: { exitCode: 0 } });
	const options = { programs: ["initial-program"] };
	const tool = createPowerShellTool(options);
	options.programs = ["replacement-program"];
	const registry = createRegistry();
	registry.install({ name: "shell", tools: [tool] });
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
					fauxAssistantMessage([fauxToolCall("powershell", { command: "echo hi" }, { id: "call" })], {
						stopReason: "toolUse",
					}),
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
		expect(exec.mock.calls.map(([command]) => command[0])).toEqual(["initial-program"]);
	} finally {
		await harness.close(context);
	}
});

it.each([createBashTool, createPowerShellTool])("resolves execution options after prepare", async (createTool) => {
	const initial = new NodeExecutionEnv({ cwd: "/initial" });
	const replacement = new NodeExecutionEnv({ cwd: "/replacement" });
	const first = vi.spyOn(initial, "exec").mockResolvedValue({ ok: true, value: { exitCode: 0 } });
	const second = vi.spyOn(replacement, "exec").mockResolvedValue({ ok: true, value: { exitCode: 0 } });
	let selected = initial;
	let changeTimeout = () => {};
	const tool = createTool({
		prepare: async (execution) => {
			execution.cwd = "/prepared";
			selected = replacement;
			changeTimeout();
		},
	});
	const registry = createRegistry();
	registry.install({
		name: "shell",
		tools: [
			{
				...tool,
				execute(args: BashToolInput, api, frame) {
					changeTimeout = () => {
						args.timeout = 2;
					};
					return tool.execute(
						args,
						{
							...api,
							get env() {
								return selected;
							},
						},
						frame,
					);
				},
			},
		],
	});
	const harness = await Harness.open(
		new MemoryStorage(),
		{ registry, models: createModels(), env: () => initial },
		context,
	);
	try {
		const root = await harness.root(context);
		const taskId = await root.commit(async (tx) => {
			const entry = await tx.appendEntry(AssistantEntry, root.id, {
				model: [
					fauxAssistantMessage([fauxToolCall(tool.name, { command: "echo fixture", timeout: 1 }, { id: "prepared" })], {
						stopReason: "toolUse",
					}),
				],
			});
			return tx.createTask(
				ToolTask,
				{ kind: "model", assistant: entry.id, callId: "prepared" },
				{ ownership: { kind: "conversation" } },
			);
		}, context);
		harness.resume();
		expect((await harness.waitForTask(taskId, context)).state.outcome.status).toBe("completed");
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledOnce();
		expect(second.mock.calls[0]?.[1]?.cwd).toBe("/prepared");
		expect(second.mock.calls[0]?.[1]?.timeout).toBe(2);
	} finally {
		await harness.close(context);
	}
});
