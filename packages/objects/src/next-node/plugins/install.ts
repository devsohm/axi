import { spawn } from "node:child_process";
import type { Context } from "../../context/index.ts";
import type { Plugin } from "./discover.ts";

export type InstallOptions = { readonly npmCommand?: readonly string[] };
export async function installDependencies(
	plugin: Plugin,
	context: Context,
	options: InstallOptions = {},
): Promise<void> {
	const command = options.npmCommand ?? ["npm"];
	if (command.length === 0) throw new Error("installDependencies: npmCommand is empty");
	context.abortSignal?.throwIfAborted();
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			command[0],
			[
				...command.slice(1),
				"install",
				"--omit=dev",
				"--legacy-peer-deps",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
			],
			{ cwd: plugin.dir, signal: context.abortSignal, stdio: ["ignore", "pipe", "pipe"] },
		);
		let output = "";
		const collect = (chunk: Buffer): void => {
			output += chunk.toString();
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`plugin "${plugin.name}": ${command[0]} install failed (exit ${code}): ${output.trim()}`));
		});
	});
}
