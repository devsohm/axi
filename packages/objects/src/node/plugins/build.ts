import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep, join } from "node:path";
import { build, type BuildFailure, type Loader, type Message, type Plugin as CompilerPlugin } from "esbuild";
import type { Context } from "../../context/index.ts";
import { discoverPackage, type Plugin } from "./discover.ts";
import { PLUGINS_SPECIFIER, packageName } from "./evaluate.ts";
import { inlineSourceMap } from "./stack.ts";
import { scopeCssModule } from "./css-modules.ts";

export type AppApi = { readonly name: string; readonly versions: readonly string[] };
export type BuildOptions = {
	readonly hostPackages: readonly string[];
	readonly platform: "node" | "browser";
	readonly plugins?: readonly Plugin[];
	readonly publicPath?: string;
	readonly api?: AppApi;
	readonly kinds?: readonly string[];
};
export type BuildInput = { readonly file: string; readonly hash: string };
export type BuiltFacet =
	| { readonly kind: "failed"; readonly plugin: string; readonly facet: string; readonly errors: readonly string[] }
	| {
			readonly kind: "script";
			readonly plugin: string;
			readonly facet: string;
			readonly source: string;
			readonly digest: string;
			readonly inputs: readonly BuildInput[];
			readonly copied: readonly string[];
			readonly css?: { readonly name: string; readonly text: string };
			readonly assets: readonly { readonly name: string; readonly bytes: Uint8Array }[];
			readonly api?: { readonly name: string; readonly version: string | undefined };
	  };
const fileHint = `a file of the plugin is read through pluginFile(path) from "${PLUGINS_SPECIFIER}"`;
const moduleIdentityError = `import.meta.url, __dirname and __filename are not available in a plugin script (${fileHint})`;
const resolving = Symbol("axi.plugins.resolving"),
	assetImport = Symbol("axi.plugins.asset");
const loaders: Readonly<Record<string, Loader>> = {
	".ts": "ts",
	".mts": "ts",
	".cts": "ts",
	".tsx": "tsx",
	".js": "js",
	".mjs": "js",
	".cjs": "js",
	".jsx": "jsx",
	".json": "json",
	".css": "css",
	".wasm": "file",
};
export function inside(directory: string, file: string): boolean {
	const local = relative(directory, file);
	return local !== "" && !local.startsWith("..") && !isAbsolute(local);
}
const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function buildError(plugin: Plugin, message: Message): string {
	const text =
		message.id === "empty-import-meta"
			? moduleIdentityError
			: message.text.startsWith("Top-level await")
				? "a plugin script has no top-level await (a facet declares synchronously)"
				: message.text;
	const at = message.location;
	if (!at) return text;
	return `${isAbsolute(at.file) ? relative(plugin.dir, at.file) : at.file}:${at.line}:${at.column + 1}: ${text}`;
}
function forbiddenGlobals(source: string): string[] {
	if (!source.includes("__axi_plugin_")) return [];
	const mapping = inlineSourceMap(source),
		errors: string[] = [];
	if (!mapping) return errors;
	for (const [line, content] of source.split("\n").entries()) {
		for (const hit of content.matchAll(/__axi_plugin_(?:dirname|filename)/g)) {
			const original = mapping.findEntry(line, hit.index);
			if ("originalSource" in original)
				errors.push(
					`${original.originalSource}:${original.originalLine + 1}:${original.originalColumn + 1}: ${moduleIdentityError}`,
				);
		}
	}
	return errors;
}

export async function buildFacet(
	plugin: Plugin,
	kind: string,
	options: BuildOptions,
	context: Context,
): Promise<BuiltFacet> {
	const failed = (errors: readonly string[]): BuiltFacet => ({
		kind: "failed",
		plugin: plugin.name,
		facet: kind,
		errors,
	});
	const namedEntry = plugin.facets[kind];
	if (namedEntry === undefined) return failed([`plugin "${plugin.name}" has no ${kind} facet`]);
	context.abortSignal?.throwIfAborted();
	const entry = await realpath(namedEntry);
	if (plugin.layout === "file" ? dirname(entry) !== plugin.dir : !inside(plugin.dir, entry))
		return failed([`${basename(namedEntry)}: the facet file links out of its plugin (${entry})`]);
	const inputs = new Map<string, string>(),
		copies = new Set<string>(),
		hosts = new Set(options.hostPackages);
	const browser = options.platform === "browser",
		peers = (options.plugins ?? []).filter((item) => item.dir !== plugin.dir && item.layout === "directory");
	const modules = join(plugin.dir, "node_modules");
	const imports = new Map<string, string>();
	const versions = new Map<string, string>();
	const styles = new Map<string, string>();
	const location = (file: string): Plugin | "package" | undefined => {
		if (inside(modules, file)) return "package";
		if (inside(plugin.dir, file)) return plugin;
		return peers.find((item) => inside(item.dir, file) && !inside(join(item.dir, "node_modules"), file));
	};
	const shown = (file: string) => relative(plugin.dir, file).split(sep).join("/");
	const kindOf = (file: string, top?: string): string | undefined => {
		const parts = basename(file).split(".");
		const label = parts.length > 2 ? parts.at(-2)
			: parts.length === 2 && (dirname(file) === top || [plugin, ...peers].some((item) => item.layout === "directory" && item.dir === dirname(file)))
				? parts[0] : undefined;
		return options.kinds?.find((item) => item.toLowerCase() === label?.toLowerCase());
	};
	const wrongKind = (file: string, specifier: string, top?: string): string | undefined => {
		const actual = kindOf(file, top);
		if (!actual || actual.toLowerCase() === kind.toLowerCase()) return;
		const chain = [file], seen = new Set(chain);
		for (let parent = imports.get(file); parent && !seen.has(parent); parent = imports.get(parent)) { seen.add(parent); chain.unshift(parent); }
		return `"${specifier}": a ${actual} file, imported into a ${kind} facet (${chain.map(shown).join(" → ")})`;
	};
	const entryKind = kindOf(entry);
	if (entryKind && entryKind.toLowerCase() !== kind.toLowerCase()) return failed([`${basename(namedEntry)}: links to a ${entryKind} file (${shown(entry)}), not a ${kind} facet`]);
	const manifests = new Map<string, Promise<"objects" | "plain" | "none">>();
	const readManifest = (dir: string) => {
		let read = manifests.get(dir);
		if (!read) {
			read = readFile(join(dir, "package.json"), "utf8").then((text): "objects" | "plain" => {
				try { return (JSON.parse(text) as { objects?: unknown } | null)?.objects === undefined ? "plain" : "objects"; }
				catch { return "plain"; }
			}, (): "none" => "none");
			manifests.set(dir, read);
		}
		return read;
	};
	const packageKind = async (file: string): Promise<{ top: string | undefined } | undefined> => {
		let nearest: string | undefined;
		for (let dir = dirname(file); inside(modules, dir); dir = dirname(dir)) {
			const manifest = await readManifest(dir);
			if (manifest === "none") continue;
			if (!nearest) {
				if (manifest === "objects") return { top: dir === dirname(file) ? dir : undefined };
				nearest = dir;
			} else {
				if (manifest === "plain") return;
				const discovered = await discoverPackage(dir, { root: dir, required: false, kinds: options.kinds ?? [] }, context);
				return discovered.plugins.some((item) => item.dir === nearest) ? { top: nearest === dirname(file) ? nearest : undefined } : undefined;
			}
		}
	};
	const copiedError = (owner: Plugin): string =>
		`a file copied from plugin "${owner.name}" may import only host packages and files of its own plugin`;
	const rules: CompilerPlugin = {
		name: "axi-plugin-inputs",
		setup(compiler) {
			compiler.onResolve({ filter: /.*/ }, async (args) => {
				if (args.path.startsWith("axi-scoped-css:")) return { path: args.path.slice(15), namespace: "axi-scoped-css" };
				if (args.kind === "entry-point") return { path: resolve(plugin.dir, args.path) };
				if (args.pluginData === resolving) return;
				const refuse = (text: string) => ({ errors: [{ text }] });
				const specifier = args.path,
					from = location(args.importer);
				if (args.kind === "dynamic-import")
					return refuse(`import("${specifier}"): a plugin script has no dynamic import (${fileHint})`);
				if (specifier === PLUGINS_SPECIFIER) return { path: specifier, external: true };
				if (options.api) {
					const api = options.api;
					if (packageName(specifier) === "@axi/objects") return refuse(`"${specifier}": plugins import Objects through the app's API ("${api.name}/${api.versions[0]}"), never directly`);
					if (specifier === api.name || specifier.startsWith(`${api.name}/`)) {
						const version = specifier.slice(api.name.length + 1).split("/")[0];
						const provided = `this app provides ${api.versions.join(", ")}`;
						if (!version) return refuse(`"${specifier}": import a version of the app's API (${provided})`);
						if (!api.versions.includes(version)) return refuse(`"${specifier}": ${api.name}/${version} is not available: ${provided}`);
						if (!hosts.has(specifier)) return refuse(`"${specifier}": not available to ${kind} facets`);
						if (!versions.has(version)) versions.set(version, args.importer);
					}
				}
				if (hosts.has(specifier)) return { path: specifier, external: true };
				if (plugin.layout === "file") return refuse(`"${specifier}": a single-file plugin imports only host packages (the app's API); make it a directory "${plugin.name}/" with a package.json`);
				if (from && from !== plugin && from !== "package" && !specifier.startsWith(".") && !isAbsolute(specifier)) return refuse(`"${specifier}": ${copiedError(from)}`);
				if (isBuiltin(specifier))
					return browser
						? refuse(`"${specifier}": a Node builtin in a browser build`)
						: { path: specifier, external: true };
				const asset = specifier.endsWith("?url") || (args.kind === "url-token" && browser);
				if (asset && !browser) return refuse(`"${specifier}": assets by URL are for browser builds (${fileHint})`);
				let target = specifier.endsWith("?url") ? specifier.slice(0, -4) : specifier;
				let packageImport = from === "package";
				if (!asset) {
					if (!packageImport && !specifier.startsWith(".") && !isAbsolute(specifier)) {
							if (plugin.external.includes(packageName(specifier)))
								return browser
									? refuse(`"${specifier}": objects.external packages are for Node builds`)
									: { path: specifier, external: true };
							if (plugin.dependencies.includes(packageName(specifier))) packageImport = true;
							else return refuse(`"${specifier}": neither a host package nor in the dependencies of plugin "${plugin.name}"`);
					}
				}
				const found = await compiler.resolve(target, {
					kind: args.kind,
					importer: args.importer,
					resolveDir: args.resolveDir,
					pluginData: resolving,
				});
				if (found.errors.length) return { errors: found.errors };
				if (found.namespace !== "file") return found;
				const to = location(found.path);
				if (packageImport) {
					if (to !== "package") return refuse(`"${specifier}": resolves outside the plugin's node_modules (${shown(found.path)})`);
					const code = await packageKind(found.path);
					if (code) {
						if (!imports.has(found.path)) imports.set(found.path, args.importer);
						const error = wrongKind(found.path, specifier, code.top);
						if (error) return refuse(error);
					}
					return { path: found.path, sideEffects: found.sideEffects, suffix: found.suffix };
				}
				if (found.path !== entry && !imports.has(found.path)) imports.set(found.path, args.importer);
				const kindError = wrongKind(found.path, specifier);
				if (kindError) return refuse(kindError);
				if (!browser && [".css", ".wasm"].includes(extname(found.path)))
					return refuse(`"${specifier}": stylesheets and assets are for browser builds`);
				if (to === plugin && from === plugin) return { path: found.path, pluginData: asset ? assetImport : undefined };
				if (to && to !== "package" && to !== plugin && to.root === plugin.root && (from === plugin || from === to)) {
					copies.add(found.path);
					return { path: found.path, pluginData: asset ? assetImport : undefined };
				}
				if (from && from !== plugin && from !== "package") return refuse(`"${specifier}": ${copiedError(from)}`);
				if (!to && inside(plugin.root, found.path)) return refuse(`"${specifier}": not a file of a plugin in this root`);
				const base = options.api ? `the app's API ("${options.api.name}/${options.api.versions[0]}")` : "a host package";
				return refuse(`"${specifier}": outside the plugin's root (base code is reached through ${base}, other repositories' plugins through dependencies)`);
			});
			compiler.onLoad({ filter: /.*/ }, async (args) => {
				if (args.namespace === "axi-scoped-css") return { contents: styles.get(args.path) ?? "", loader: "css", resolveDir: dirname(args.path) };
				if (args.namespace !== "file" || location(args.path) === "package") return;
				const loader = args.pluginData === assetImport ? "file" : loaders[extname(args.path)];
				if (loader === undefined) return;
				const contents = await readFile(args.path);
				inputs.set(args.path, hash(contents));
				if (args.pluginData !== assetImport && args.path.endsWith(".module.css")) {
					const scoped = await scopeCssModule(plugin.name, plugin.dir, args.path, contents.toString());
					styles.set(args.path, scoped.css);
					return { contents: `import ${JSON.stringify(`axi-scoped-css:${args.path}`)};export default ${JSON.stringify(scoped.classes)};`, loader: "js", resolveDir: dirname(args.path) };
				}
				return { contents, loader, resolveDir: dirname(args.path) };
			});
		},
	};
	let result: Awaited<ReturnType<typeof build>>;
	try {
		result = await build({
			entryPoints: [entry],
			absWorkingDir: plugin.dir,
			outdir: plugin.dir,
			entryNames: "[name]-[hash]",
			assetNames: "[name]-[hash]",
			publicPath: options.publicPath ?? "/",
			write: false,
			bundle: true,
			format: "cjs",
			platform: options.platform,
			target: browser ? "es2022" : "node22",
			minify: true,
			legalComments: "none",
			sourcemap: "inline",
			sourcesContent: false,
			tsconfigRaw: "{}",
			jsx: "automatic",
			banner: { js: "(function (require, module, exports) {" },
			footer: { js: "})" },
			define: { __dirname: "__axi_plugin_dirname", __filename: "__axi_plugin_filename" },
			logOverride: { "empty-import-meta": "error" },
			supported: { "dynamic-import": false },
			logLevel: "silent",
			plugins: [rules],
		});
	} catch (error) {
		const messages = (error as BuildFailure).errors;
		return failed(messages ? messages.map((message) => buildError(plugin, message)) : [String(error)]);
	}
	const files = result.outputFiles!,
		javascript = files.find((file) => file.path.endsWith(".js"))!,
		css = files.find((file) => file.path.endsWith(".css"));
	const source = javascript.text,
		errors = forbiddenGlobals(source);
	if (versions.size > 1) errors.push(`one facet imports one version of ${options.api!.name}: this one imports ${[...versions].sort(([a], [b]) => a.localeCompare(b)).map(([version, importer]) => `${options.api!.name}/${version} (${shown(importer)})`).join(" and ")}`);
	if (errors.length) return failed(errors);
	return {
		kind: "script",
		plugin: plugin.name,
		facet: kind,
		source,
		digest: hash(source),
		inputs: [...inputs].sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, hash]) => ({ file, hash })),
		copied: [...copies].sort(),
		...(css ? { css: { name: basename(css.path), text: css.text } } : {}),
		assets: files
			.filter((file) => file !== javascript && file !== css)
			.map((file) => ({ name: relative(plugin.dir, file.path), bytes: file.contents })),
		...(options.api ? { api: { name: options.api.name, version: versions.keys().next().value } } : {}),
	};
}
