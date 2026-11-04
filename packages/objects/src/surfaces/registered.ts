import type { Principal } from "../data/index.ts";
import type { Facet } from "../host/index.ts";
export const REGISTER = "objectsFacet";
export type FacetFunction = (
	require: (specifier: string) => unknown,
	module: { exports: unknown },
	exports: unknown,
) => void;
export type RegisteredScript = { readonly plugin: string; readonly digest: string; readonly run: FacetFunction };
export type ClientModules = Readonly<Record<string, unknown>>;
export function registeredSource(plugin: string, digest: string, source: string): string {
	return [REGISTER, "(", JSON.stringify(plugin), ",", JSON.stringify(digest), ",", source, "\n);\n"].join("");
}
const namespaces = new WeakMap<object, object>();
export function interop(value: unknown): unknown {
	if (value === null || typeof value !== "object" || Object.prototype.toString.call(value) !== "[object Module]")
		return value;
	if (!namespaces.has(value)) namespaces.set(value, { ...value, __esModule: true });
	return namespaces.get(value);
}
export function evaluateRegistered<P extends Principal = Principal>(
	script: RegisteredScript,
	modules: ClientModules,
): Facet<P> {
	const module: { exports: unknown } = { exports: {} };
	script.run(
		(specifier) => {
			if (!Object.hasOwn(modules, specifier))
				throw new Error(`plugin "${script.plugin}": "${specifier}" is not one of this client's host packages`);
			return interop(modules[specifier]);
		},
		module,
		module.exports,
	);
	const candidate =
		module.exports && (typeof module.exports === "object" || typeof module.exports === "function")
			? Reflect.get(module.exports, "default")
			: undefined;
	if (candidate === null || typeof candidate !== "object" || typeof Reflect.get(candidate, "setup") !== "function")
		throw new Error(`plugin "${script.plugin}": its default export is not a facet (defineFacet)`);
	return candidate as Facet<P>;
}
