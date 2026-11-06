import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "../../context/index.ts";
import { isPluginName } from "../../host/staging.ts";

export type PluginRoot = string | { readonly path: string; readonly required?: boolean };
export type RootContext = { readonly root: string; readonly required: boolean; readonly kinds: readonly string[] };
export type Plugin = {
	readonly name: string;
	readonly dir: string;
	readonly root: string;
	readonly required: boolean;
	readonly layout: "directory" | "file";
	readonly facets: Readonly<Record<string, string>>;
	readonly dependencies: readonly string[];
	readonly external: readonly string[];
};
export type DiscoveryProblem = {
	readonly path: string;
	readonly error: string;
	readonly root: string;
	readonly required: boolean;
};
export type Discovery = { readonly plugins: readonly Plugin[]; readonly problems: readonly DiscoveryProblem[] };
export type DiscoveryOptions = { readonly kinds: readonly string[] };
export const FACET_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".mjs"];

function errorCode(error: unknown): unknown {
	return error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
}
async function entriesOf(root: string): Promise<{ dirs: string[]; files: string[] } | undefined> {
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
	const result = { dirs: [] as string[], files: [] as string[] };
	for (const name of entries.sort()) {
		if (name.startsWith(".") || name === "node_modules") continue;
		const file = join(root, name),
			info = await stat(file).catch(() => undefined);
		if (info?.isDirectory()) result.dirs.push(await realpath(file));
		else if (info?.isFile()) result.files.push(name);
	}
	return result;
}
async function readPlugin(dir: string, at: RootContext, manifest: unknown): Promise<Plugin | string> {
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
	for (const kind of at.kinds) {
		const matches = FACET_EXTENSIONS.map((extension) => kind + extension).filter((name) => files.has(name));
		if (matches.length > 1) return `two ${kind} facets: ${matches.join(", ")}`;
		if (matches.length === 1) facets[kind] = join(dir, matches[0]);
	}
	return {
		name: data.name,
		dir,
		root: at.root,
		required: at.required,
		layout: "directory",
		facets,
		dependencies:
			typeof data.dependencies === "object" && data.dependencies !== null ? Object.keys(data.dependencies) : [],
		external,
	};
}
export async function discoverPlugins(
	roots: readonly PluginRoot[],
	options: DiscoveryOptions,
	context: Context,
): Promise<Discovery> {
	const found = new Map<string, Plugin>(),
		problems: DiscoveryProblem[] = [];
	for (const root of roots) {
		const path = typeof root === "string" ? root : root.path;
		const required = typeof root !== "string" && root.required === true;
		const entries = await entriesOf(path);
		if (!entries) {
			if (required) problems.push({ path, error: "the required root does not exist", root: path, required });
			continue;
		}
		const at = { root: await realpath(path), required, kinds: options.kinds };
		const plugins: Plugin[] = [];
		for (const directory of entries.dirs) {
			const discovered = await discoverPackage(directory, at, context);
			plugins.push(...discovered.plugins);
			problems.push(...discovered.problems);
		}
		const single = filePlugins(entries.files, at);
		problems.push(...single.problems);
		for (const plugin of single.plugins) {
			const directory = plugins.find((other) => other.name === plugin.name);
			if (directory) problems.push({
				path: Object.values(plugin.facets)[0]!,
				error: `plugin "${plugin.name}" is in ${directory.dir} already`,
				root: at.root, required,
			});
			else plugins.push(plugin);
		}
		for (const plugin of plugins) {
			const previous = found.get(plugin.name);
			if (previous)
				problems.push({
					path: plugin.layout === "file" ? Object.values(plugin.facets)[0]! : plugin.dir,
					error: `plugin "${plugin.name}" is in ${previous.dir} already`,
					root: at.root,
					required,
				});
			else found.set(plugin.name, plugin);
		}
	}
	return { plugins: [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), problems };
}

export function sameFiles(before: Plugin, after: Plugin): boolean {
	return (
		before.dir === after.dir &&
		before.layout === after.layout &&
		JSON.stringify(Object.entries(before.facets).sort()) === JSON.stringify(Object.entries(after.facets).sort())
	);
}
type Manifest = { readonly value: unknown } | { readonly error: string } | { readonly missing: true };
async function manifest(dir: string): Promise<Manifest> {
	try {
		return { value: JSON.parse(await readFile(join(dir, "package.json"), "utf8")) };
	} catch (error) {
		return errorCode(error) === "ENOENT"
			? { missing: true }
			: { error: `package.json: ${error instanceof Error ? error.message : String(error)}` };
	}
}
export async function discoverPackage(dir: string, at: RootContext, context: Context): Promise<Discovery> {
	context.abortSignal?.throwIfAborted();
	dir = await realpath(dir);
	const info = await manifest(dir);
	const problems: DiscoveryProblem[] = [],
		plugins: Plugin[] = [];
	const problem = (path: string, error: string) => problems.push({ path, error, root: at.root, required: at.required });
	const accept = async (folder: string, source: Manifest) => {
		if ("missing" in source) {
			problem(folder, "no package.json");
			return;
		}
		if ("error" in source) {
			problem(folder, source.error);
			return;
		}
		const plugin = await readPlugin(folder, at, source.value);
		if (typeof plugin === "string") problem(folder, plugin);
		else plugins.push(plugin);
	};
	if ("error" in info) {
		problem(dir, info.error);
		return { plugins, problems };
	}
	const listed =
		"value" in info ? (info.value as { objects?: { plugins?: unknown } } | null)?.objects?.plugins : undefined;
	if (listed !== undefined) {
		const fail = (text: string) => problem(dir, `package.json: objects.plugins ${text}`);
		if (!Array.isArray(listed) || !listed.every((item): item is string => typeof item === "string"))
			fail("is not a list of plugin folders");
		else {
			const omitted = listed.filter((path) => path.startsWith("!")).map((path) => normalized(path.slice(1)));
			const selected = new Set<string>();
			for (const entry of listed.filter((path) => !path.startsWith("!"))) {
				const matches = /[*?]/.test(entry) ? await foldersMatching(dir, normalized(entry)) : [resolve(dir, entry)];
				for (const folder of matches) {
					const rest = relative(dir, folder);
					if (rest.startsWith("..") || isAbsolute(rest)) {
						fail(`"${entry}" leaves the package`);
						return { plugins, problems };
					}
					if (!omitted.some((pattern) => glob(normalized(rest) || ".", pattern))) selected.add(folder);
				}
			}
			const sorted = [...selected].sort();
			for (const inner of sorted) {
				const outer = sorted.find((parent) => parent !== inner && within(parent, inner));
				if (outer) {
					fail(
						`lists "${normalized(relative(dir, inner)) || "."}" inside the listed "${normalized(relative(dir, outer)) || "."}"`,
					);
					return { plugins, problems };
				}
			}
			if (!sorted.length) fail("lists no plugin folder");
			for (const folder of sorted) {
				if (!(await stat(folder).catch(() => undefined))?.isDirectory()) {
					problem(folder, "listed in objects.plugins, not a directory");
					continue;
				}
				const real = await realpath(folder);
				if (!within(dir, real)) {
					problem(folder, "listed in objects.plugins, links out of the package");
					continue;
				}
				await accept(real, await manifest(real));
			}
		}
	} else {
		const entries = await entriesOf(dir);
		const hasFacet = at.kinds.some((kind) => FACET_EXTENSIONS.some((ext) => entries?.files.includes(kind + ext)));
		if ("value" in info && hasFacet) await accept(dir, info);
		else {
			let children = false;
			for (const folder of entries?.dirs ?? []) {
				const child = await manifest(folder);
				if (!("missing" in child)) {
					children = true;
					await accept(folder, child);
				}
			}
			if (!children) await accept(dir, info);
		}
	}
	return { plugins, problems };
}
function normalized(path: string): string {
	return path.split(sep).join("/").replace(/^\.\//, "");
}
function within(parent: string, child: string): boolean {
	const rest = relative(parent, child);
	return !rest.startsWith("..") && !isAbsolute(rest);
}
function glob(path: string, pattern: string): boolean {
	const source = pattern
		.split(/(\*\*\/|\*\*|\*|\?)/)
		.map((token) => {
			switch (token) {
				case "**/":
					return "(?:.*/)?";
				case "**":
					return ".*";
				case "*":
					return "[^/]*";
				case "?":
					return "[^/]";
				default:
					return token.replace(/[.+^${}()|[\]\\]/g, "\\$&");
			}
		})
		.join("");
	return new RegExp(`^${source}$`).test(path);
}
async function foldersMatching(root: string, pattern: string): Promise<string[]> {
	const matches: string[] = [];
	let level = [root];
	for (let depth = 0; depth < 6 && level.length; depth++) {
		const next: string[] = [];
		for (const parent of level)
			for (const entry of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
				if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
				const path = join(parent, entry.name);
				if (glob(normalized(relative(root, path)), pattern)) matches.push(path);
				next.push(path);
			}
		level = next;
	}
	return matches;
}
function filePlugins(files: readonly string[], at: RootContext): Discovery {
	const groups = new Map<string, Map<string, string[]>>();
	for (const file of files) {
		const ext = FACET_EXTENSIONS.find((ext) => file.endsWith(ext));
		if (!ext) continue;
		const stem = file.slice(0, -ext.length),
			dot = stem.lastIndexOf("."),
			kind = stem.slice(dot + 1),
			name = stem.slice(0, dot);
		if (dot < 1 || !at.kinds.includes(kind)) continue;
		const facets = groups.get(name) ?? new Map<string, string[]>();
		facets.set(kind, [...(facets.get(kind) ?? []), file]);
		groups.set(name, facets);
	}
	const plugins: Plugin[] = [],
		problems: DiscoveryProblem[] = [];
	for (const [name, kinds] of groups) {
		const first = join(at.root, [...kinds.values()][0]![0]!);
		let error: string | undefined;
		if (!isPluginName(name) || name.startsWith("@")) error = `"${name}" is not a valid unscoped plugin name`;
		const repeated = [...kinds].find(([, files]) => files.length > 1);
		if (!error && repeated) error = `two ${repeated[0]} facets: ${repeated[1].join(", ")}`;
		if (error) problems.push({ path: first, error, root: at.root, required: at.required });
		else
			plugins.push({
				name,
				dir: at.root,
				root: at.root,
				required: at.required,
				layout: "file",
				facets: Object.fromEntries([...kinds].map(([kind, files]) => [kind, join(at.root, files[0]!)])),
				dependencies: [],
				external: [],
			});
	}
	return { plugins, problems };
}
