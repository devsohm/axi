import type { Context } from "@axi/chord";
import { type Static, Type } from "typebox";
import { defineTool } from "../harness/define.ts";
import type { ToolExecutionApi, ToolExecutionResult } from "../harness/types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../truncate.ts";
import { requireEnv } from "./env.ts";

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});
const powershellSchema = Type.Object({
	command: Type.String({ description: "PowerShell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});
const resultSchema = Type.Object({
	output: Type.String({ description: "Combined stdout and stderr: the retained tail, as the model sees it" }),
	truncated: Type.Boolean({ description: "Whether earlier output was dropped" }),
	fullOutputPath: Type.Optional(Type.String({ description: "File with the complete output, when it was spilled" })),
	exitCode: Type.Number(),
});
export type BashToolInput = Static<typeof bashSchema>;
export type PowerShellToolInput = Static<typeof powershellSchema>;
export type ShellStructuredOutput = Static<typeof resultSchema>;
export interface BashExecution {
	command: string;
	cwd: string;
	env: Record<string, string>;
	inheritEnv: boolean;
}
export type BashPrepare = (execution: BashExecution, api: ToolExecutionApi, context: Context) => void | Promise<void>;
export interface BashToolOptions {
	commandPrefix?: string;
	prepare?: BashPrepare;
}
export interface PowerShellToolOptions extends BashToolOptions {
	programs?: readonly string[];
}

async function executeShell(
	args: BashToolInput,
	api: ToolExecutionApi,
	context: Context,
	options: BashToolOptions | undefined,
	commands: (script: string) => readonly (string | readonly string[])[],
): Promise<ToolExecutionResult> {
	let { timeout } = args;
	if (timeout !== undefined) {
		if (!Number.isFinite(timeout) || timeout <= 0)
			throw new Error("Invalid timeout: must be a finite number of seconds");
		if (timeout > 2_147_483.647) throw new Error("Invalid timeout: maximum is 2147483.647 seconds");
	}
	const execution: BashExecution = {
		command: options?.commandPrefix ? `${options.commandPrefix}\n${args.command}` : args.command,
		cwd: requireEnv(api).cwd,
		env: {},
		inheritEnv: true,
	};
	await options?.prepare?.(execution, api, context);
	timeout = args.timeout;
	const env = requireEnv(api);
	let result: Awaited<ReturnType<typeof env.exec>> | undefined;
	for (const command of commands(execution.command)) {
		result = await env.exec(
			command,
			{
				cwd: execution.cwd,
				env: execution.env,
				inheritEnv: execution.inheritEnv,
				...(timeout === undefined ? {} : { timeout }),
				onOutput: (text, _context, info) => api.output(text, info.skipped),
				spill: { afterBytes: DEFAULT_MAX_BYTES, afterLines: DEFAULT_MAX_LINES },
				...(api.outputWindow === undefined ? {} : { window: api.outputWindow }),
			},
			context,
		);
		if (result.ok || result.error.code !== "spawn_error") break;
	}
	if (result === undefined) throw new Error("No command to run");
	const spill = result.ok ? result.value.spillPath : result.error.spillPath;
	if (spill !== undefined) api.diagnostic({ severity: "info", code: "full_output", message: `Full output: ${spill}` });
	if (!result.ok) {
		if (result.error.code === "aborted" && context.abortSignal?.aborted) throw result.error;
		if (result.error.code === "timeout") throw new Error(`Command timed out after ${timeout} seconds`);
		if (result.error.code === "aborted") throw new Error("Command aborted");
		throw result.error;
	}
	const retained = api.retainedOutput();
	const exitCode = result.value.exitCode;
	const structuredOutput: ShellStructuredOutput = {
		output: retained.text,
		truncated: retained.truncated,
		...(spill === undefined ? {} : { fullOutputPath: spill }),
		exitCode,
	};
	return exitCode === 0
		? { structuredOutput }
		: {
				structuredOutput,
				isError: true,
				diagnostics: [{ severity: "error", code: "exit_code", message: `Command exited with code ${exitCode}` }],
			};
}

function description(shell: string): string {
	return `Execute a ${shell} command in the current working directory. Returns combined stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`;
}
export function createBashTool(options?: BashToolOptions) {
	return defineTool({
		name: "bash",
		description: description("bash"),
		parameters: bashSchema,
		structuredOutputSchema: resultSchema,
		outputLimits: { retain: "tail" },
		execute: (args, api, context) => executeShell(args, api, context, options, (script) => [script]),
	});
}
export function createPowerShellTool(options?: PowerShellToolOptions) {
	const programs = options?.programs ?? ["pwsh", "powershell"];
	return defineTool({
		name: "powershell",
		description: description("PowerShell"),
		parameters: powershellSchema,
		structuredOutputSchema: resultSchema,
		outputLimits: { retain: "tail" },
		execute: (args, api, context) =>
			executeShell(args, api, context, options, (script) =>
				programs.map((program) => [
					program,
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-Command",
					`try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n${script}`,
				]),
			),
	});
}
