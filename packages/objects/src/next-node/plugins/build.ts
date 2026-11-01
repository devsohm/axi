import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep, join } from "node:path";
import { build, type BuildFailure, type Loader, type Message, type Plugin as CompilerPlugin } from "esbuild";
import type { Context } from "../../context/index.ts";
import type { Plugin } from "./discover.ts";
import { PLUGINS_SPECIFIER, packageName } from "./evaluate.ts";
import { inlineSourceMap } from "./stack.ts";

export type BuildOptions = {
	readonly hostPackages: readonly string[];
	readonly platform: "node" | "browser";
	readonly plugins?: readonly Plugin[];
	readonly publicPath?: string;
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
	const entry = plugin.facets[kind];
	if (entry === undefined) return failed([`plugin "${plugin.name}" has no ${kind} facet`]);
	context.abortSignal?.throwIfAborted();
	const inputs = new Map<string, string>(),
		copies = new Set<string>(),
		hosts = new Set(options.hostPackages);
	const browser = options.platform === "browser",
		peers = (options.plugins ?? []).filter((item) => item.dir !== plugin.dir);
	const location = (file: string): Plugin | "package" | undefined => {
		if (file.split(sep).includes("node_modules")) return "package";
		if (inside(plugin.dir, file)) return plugin;
		return peers.find((item) => inside(item.dir, file));
	};
	const copiedError = (owner: Plugin): string =>
		`a file copied from plugin "${owner.name}" may import only host packages and files of its own plugin`;
	const rules: CompilerPlugin = {
		name: "axi-plugin-inputs",
		setup(compiler) {
			compiler.onResolve({ filter: /.*/ }, async (args) => {
				if (args.kind === "entry-point") return { path: resolve(plugin.dir, args.path) };
				if (args.pluginData === resolving) return;
				const refuse = (text: string) => ({ errors: [{ text }] });
				const specifier = args.path,
					from = location(args.importer);
				if (args.kind === "dynamic-import")
					return refuse(`import("${specifier}"): a plugin script has no dynamic import (${fileHint})`);
				if (specifier === PLUGINS_SPECIFIER || hosts.has(specifier)) return { path: specifier, external: true };
				if (isBuiltin(specifier))
					return browser
						? refuse(`"${specifier}": a Node builtin in a browser build`)
						: { path: specifier, external: true };
				const asset = specifier.endsWith("?url");
				if (asset && !browser) return refuse(`"${specifier}": assets by URL are for browser builds (${fileHint})`);
				let target = asset ? specifier.slice(0, -4) : specifier;
				let named: Plugin | undefined;
				if (!asset) {
					if (from === "package") return;
					if (!specifier.startsWith(".") && !isAbsolute(specifier)) {
						const name = packageName(specifier);
						named = name === plugin.name ? plugin : peers.find((item) => item.name === name);
						if (named) {
							const file = specifier.slice(name.length + 1);
							if (!file) return refuse(`"${specifier}": names plugin "${name}", not a file of it ("${name}/contract")`);
							if (from && from !== plugin && from !== named) return refuse(`"${specifier}": ${copiedError(from)}`);
							target = join(named.dir, file);
						} else {
							if (from && from !== plugin) return refuse(`"${specifier}": ${copiedError(from)}`);
							if (plugin.external.includes(packageName(specifier)))
								return browser
									? refuse(`"${specifier}": objects.external packages are for Node builds`)
									: { path: specifier, external: true };
							if (plugin.dependencies.includes(packageName(specifier))) return;
							return refuse(
								`"${specifier}": neither a host package, in the dependencies of plugin "${plugin.name}" nor a discovered plugin "${name}"`,
							);
						}
					}
				}
				const found = await compiler.resolve(target, {
					kind: args.kind,
					importer: args.importer,
					resolveDir: args.resolveDir,
					pluginData: resolving,
				});
				if (found.errors.length) return { errors: found.errors };
				if (!browser && [".css", ".wasm"].includes(extname(found.path)))
					return refuse(`"${specifier}": stylesheets and assets are for browser builds`);
				const to = location(found.path);
				if (to === plugin && from === plugin) return { path: found.path, pluginData: asset ? assetImport : undefined };
				if (to && to !== "package" && to !== plugin && (named === to || from === to)) {
					copies.add(found.path);
					return { path: found.path, pluginData: asset ? assetImport : undefined };
				}
				if (to && to !== "package" && to !== plugin && from === plugin)
					return refuse(
						`"${specifier}": a relative path into plugin "${to.name}" (import its files by name: "${to.name}/…")`,
					);
				return refuse(
					`"${specifier}": ${from && from !== "package" && from !== plugin ? copiedError(from) : "outside the plugin (base code is reached through a host package, packages through dependencies)"}`,
				);
			});
			compiler.onLoad({ filter: /.*/ }, async (args) => {
				if (args.namespace !== "file" || location(args.path) === "package") return;
				const loader = args.pluginData === assetImport ? "file" : loaders[extname(args.path)];
				if (loader === undefined) return;
				const contents = await readFile(args.path);
				inputs.set(args.path, hash(contents));
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
	};
}
