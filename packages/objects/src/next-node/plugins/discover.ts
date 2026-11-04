import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../../context/index.ts";
import { isPluginName } from "../../next/host/staging.ts";

export type Plugin = {
	readonly name: string;
	readonly dir: string;
	readonly facets: Readonly<Record<string, string>>;
	readonly dependencies: readonly string[];
	readonly external: readonly string[];
};
export type DiscoveryProblem = { readonly path: string; readonly error: string };
export type Discovery = { readonly plugins: readonly Plugin[]; readonly problems: readonly DiscoveryProblem[] };
export type DiscoveryOptions = { readonly kinds: readonly string[] };
export const FACET_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".mjs"];

function errorCode(error: unknown): unknown {
	return error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
}
async function candidates(root: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
	const result: string[] = [];
	for (const name of entries.sort()) {
		if (name.startsWith(".") || name === "node_modules") continue;
		const file = join(root, name),
			info = await stat(file).catch(() => undefined);
		if (info?.isDirectory()) result.push(await realpath(file));
	}
	return result;
}
async function readPlugin(dir: string, kinds: readonly string[]): Promise<Plugin | string> {
	let manifest: unknown;
	try {
		manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
	} catch (error) {
		return errorCode(error) === "ENOENT"
			? "no package.json"
			: `package.json: ${error instanceof Error ? error.message : String(error)}`;
	}
	const data = (manifest ?? {}) as {
		readonly name?: unknown;
		readonly dependencies?: unknown;
		readonly objects?: { readonly external?: unknown };
	};
	if (typeof data.name !== "string" || !isPluginName(data.name))
		return `package.json: ${JSON.stringify(data.name)} is not a valid plugin name`;
	const external = data.objects?.external ?? [];
	if (!Array.isArray(external) || !external.every((item): item is string => typeof item === "string"))
		return "package.json: objects.external is not a list of package names";
	const files = new Set(await readdir(dir)),
		facets: Record<string, string> = {};
	for (const kind of kinds) {
		const matches = FACET_EXTENSIONS.map((extension) => kind + extension).filter((name) => files.has(name));
		if (matches.length > 1) return `two ${kind} facets: ${matches.join(", ")}`;
		if (matches.length === 1) facets[kind] = join(dir, matches[0]);
	}
	return {
		name: data.name,
		dir,
		facets,
		dependencies:
			typeof data.dependencies === "object" && data.dependencies !== null ? Object.keys(data.dependencies) : [],
		external,
	};
}
export async function discoverPlugins(
	roots: readonly string[],
	options: DiscoveryOptions,
	context: Context,
): Promise<Discovery> {
	const found = new Map<string, Plugin>(),
		problems: DiscoveryProblem[] = [];
	for (const root of roots) {
		for (const dir of await candidates(root)) {
			context.abortSignal?.throwIfAborted();
			const plugin = await readPlugin(dir, options.kinds);
			if (typeof plugin === "string") {
				problems.push({ path: dir, error: plugin });
				continue;
			}
			const previous = found.get(plugin.name);
			if (previous) problems.push({ path: dir, error: `plugin "${plugin.name}" is in ${previous.dir} already` });
			else found.set(plugin.name, plugin);
		}
	}
	return { plugins: [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), problems };
}
