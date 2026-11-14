import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Context } from "../../context/index.ts";
import { isPluginName } from "../../host/staging.ts";
import { discoverPackage, discoverPlugins, type Plugin, type PluginRoot } from "./discover.ts";

export type InstallOptions = { readonly npmCommand?: readonly string[] };
export type InstallPluginOptions = InstallOptions & {
	readonly kinds?: readonly string[];
	readonly roots?: readonly PluginRoot[];
};
export type PluginSource =
	| { readonly git: string; readonly ref: string }
	| { readonly npm: string; readonly version: string };
const installArgs = ["install", "--omit=dev", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund"];
export async function installDependencies(
	plugin: Plugin,
	context: Context,
	options: InstallOptions = {},
): Promise<void> {
	if (plugin.layout === "file") throw new Error(`plugin "${plugin.name}": a single-file plugin has no package.json`);
	const command = options.npmCommand ?? ["npm"];
	if (command.length === 0) throw new Error("npmCommand is empty");
	await run(
		command[0],
		[...command.slice(1), ...installArgs],
		plugin.dir,
		context,
		`plugin "${plugin.name}": ${command[0]} install`,
	);
}

export async function installPlugin(
	source: PluginSource,
	root: string,
	context: Context,
	options: InstallPluginOptions = {},
): Promise<readonly string[]> {
	const inputs =
		"git" in source
			? [
					["repository", source.git],
					["ref", source.ref],
				]
			: [
					["package", source.npm],
					["version", source.version],
				];
	for (const [field, input] of inputs)
		if (input === "" || input.startsWith("-")) throw new Error(`installPlugin: ${field} "${input}" is refused`);
	const name = "git" in source ? basename(source.git.replace(/\/+$/, "")).replace(/\.git$/, "") : source.npm;
	if ("git" in source ? !name || name.startsWith(".") || name.startsWith("-") : !isPluginName(name))
		throw new Error(
			"git" in source
				? `installPlugin: "${source.git}" names no repository directory`
				: `installPlugin: "${name}" is not an npm package name`,
		);
	const prefix = ".objects-install-";
	for (const entry of await readdir(root).catch(() => [])) {
		if (!entry.startsWith(prefix)) continue;
		const path = join(root, entry);
		const info = await stat(path).catch(() => undefined);
		if (info && Date.now() - info.mtimeMs > 3600000) await rm(path, { force: true, recursive: true });
	}
	const target = join(root, name);
	let scope: string | undefined;
	if (name.startsWith("@")) {
		try {
			await mkdir(dirname(target));
			scope = dirname(target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	try {
		await mkdir(target);
	} catch (error) {
		if (scope) await rmdir(scope).catch(() => {});
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`installPlugin: ${target} exists already`);
		throw error;
	}
	let staging: string | undefined;
	try {
		staging = await mkdtemp(join(root, prefix));
		const payload = join(staging, "package");
		await mkdir(payload);
		if ("git" in source) {
			const label = `git clone of ${source.git} at ${source.ref}`;
			await run("git", ["init", "--quiet"], payload, context, label);
			await run("git", ["fetch", "--quiet", "--depth", "1", "--", source.git, source.ref], payload, context, label);
			await run(
				"git",
				["-c", "advice.detachedHead=false", "checkout", "--quiet", "FETCH_HEAD", "--"],
				payload,
				context,
				label,
			);
		} else {
			const command = options.npmCommand ?? ["npm"];
			if (!command.length) throw new Error("npmCommand is empty");
			const packDir = await mkdtemp(join(staging, "pack-"));
			const label = `${command[0]} pack ${source.npm}@${source.version}`;
			const packed = JSON.parse(
				await run(
					command[0],
					[
						...command.slice(1),
						"pack",
						"--json",
						"--pack-destination",
						packDir,
						"--",
						`${source.npm}@${source.version}`,
					],
					packDir,
					context,
					label,
				),
			) as { filename: string }[] | Record<string, { filename: string } | undefined>;
			const tarball = Array.isArray(packed) ? packed[0] : packed[source.npm];
			if (!tarball) throw new Error(`${label}: packed nothing`);
			await run(
				"tar",
				["-xzf", join(packDir, basename(tarball.filename)), "--strip-components=1", "-C", payload],
				packDir,
				context,
				`extracting ${source.npm}`,
			);
		}
		const at = { root, required: false, kinds: options.kinds ?? [] };
		const discovery = await discoverPackage(payload, at, context);
		if (discovery.problems[0])
			throw new Error(
				`installPlugin: ${discovery.problems[0].path.replace(payload, target)}: ${discovery.problems[0].error}`,
			);
		if (!discovery.plugins.length) throw new Error(`installPlugin: ${target} holds no plugin`);
		const existing = await discoverPlugins(options.roots ?? [root], { kinds: at.kinds }, context);
		for (const plugin of discovery.plugins) {
			const duplicate = existing.plugins.find((other) => other.name === plugin.name);
			if (duplicate) throw new Error(`installPlugin: plugin "${plugin.name}" is in ${duplicate.dir} already`);
		}
		if (process.platform === "win32") await rmdir(target);
		await rename(payload, target);
		const { plugins } = await discoverPackage(target, at, context);
		for (const plugin of plugins) await installDependencies(plugin, context, options);
		return plugins.map(({ name }) => name);
	} catch (error) {
		await rm(target, { recursive: true, force: true });
		if (scope) await rmdir(scope).catch(() => {});
		throw error;
	} finally {
		if (staging) await rm(staging, { recursive: true, force: true });
	}
}

async function run(
	command: string,
	args: readonly string[],
	cwd: string,
	context: Context,
	label: string,
): Promise<string> {
	context.abortSignal?.throwIfAborted();
	return new Promise<string>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			signal: context.abortSignal,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		let output = "";
		let stdout = "";
		const collect = (chunk: Buffer): void => {
			output += chunk.toString();
		};
		child.stdout.on("data", (chunk: Buffer) => {
			collect(chunk);
			stdout += chunk.toString();
		});
		child.stderr.on("data", collect);
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(`${label} failed (exit ${code}): ${output.trim()}`));
		});
	});
}
