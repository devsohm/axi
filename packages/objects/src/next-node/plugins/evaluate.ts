import { createRequire, isBuiltin } from "node:module";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { Script } from "node:vm";
import type { Principal } from "../../next/data/index.ts";
import type { Facet } from "../../next/host/index.ts";
import type { BuiltFacet } from "./build.ts";
export const PLUGINS_SPECIFIER = "@axi/objects/next/plugins";
export function packageName(specifier: string): string {
	return specifier
		.split("/")
		.slice(0, specifier.startsWith("@") ? 2 : 1)
		.join("/");
}
import type { Plugin } from "./discover.ts";
import { registerScript } from "./stack.ts";

export type HostPackages = Readonly<Record<string, unknown>>;
export type EvaluateOptions = { readonly hostPackages: HostPackages; readonly plugin: Plugin };
export type BuiltScript = Extract<BuiltFacet, { readonly kind: "script" }>;
const namespaces = new WeakMap<object, object>();
function asCommonJs(value: unknown): unknown {
	if (value === null || typeof value !== "object" || Object.prototype.toString.call(value) !== "[object Module]")
		return value;
	let namespace = namespaces.get(value);
	if (!namespace) {
		namespace = { ...value, __esModule: true };
		namespaces.set(value, namespace);
	}
	return namespace;
}
export function pluginFile(path: string): string {
	throw new Error(`pluginFile("${path}"): only a plugin's facet script, evaluated by the plugins component, has one`);
}
export function evaluateFacet<P extends Principal = Principal>(built: BuiltScript, options: EvaluateOptions): Facet<P> {
	const { plugin, hostPackages } = options,
		label = `plugin "${plugin.name}" (${built.facet})`;
	const filename = `/axi-plugins/${plugin.name}/${basename(plugin.facets[built.facet] ?? `${built.facet}.js`)}?${built.digest}`;
	const run = new Script(built.source, { filename }).runInThisContext() as (
		require: (specifier: string) => unknown,
		module: { exports: unknown },
		exports: unknown,
	) => void;
	let nativeRequire: NodeJS.Require | undefined;
	let helpers: { readonly pluginFile: (path: string) => string } | undefined;
	const requireForScript = (specifier: string): unknown => {
		if (Object.hasOwn(hostPackages, specifier)) return asCommonJs(hostPackages[specifier]);
		if (specifier === PLUGINS_SPECIFIER)
			return (helpers ??= {
				pluginFile: (path) => {
					const file = resolve(plugin.dir, path),
						remainder = relative(plugin.dir, file);
					if (remainder.startsWith("..") || isAbsolute(remainder))
						throw new Error(`pluginFile("${path}"): outside the directory of plugin "${plugin.name}"`);
					return file;
				},
			});
		if (isBuiltin(specifier) || plugin.external.includes(packageName(specifier))) {
			nativeRequire ??= createRequire(join(plugin.dir, "package.json"));
			return nativeRequire(specifier);
		}
		throw new Error(
			`${label}: "${specifier}" is not a host package, a Node builtin or one of its objects.external packages`,
		);
	};
	const module = { exports: {} as unknown };
	let exported: unknown;
	try {
		run(requireForScript, module, module.exports);
		exported = (module.exports as { readonly default?: unknown } | null)?.default;
		if (exported === null || typeof exported !== "object" || typeof Reflect.get(exported, "setup") !== "function")
			throw new Error(`${label}: its default export is not a facet (defineFacet)`);
	} catch (error) {
		if (error !== null && typeof error === "object") registerScript(filename, built.source, plugin.dir, error);
		throw error;
	}
	registerScript(filename, built.source, plugin.dir, exported);
	return exported as Facet<P>;
}
