import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import type { Facet, FacetDefinition, FacetLoader } from "./host.ts";

const parameter = "axi-reload";
const directories = new Set<string>();
let registered = false,
	generation = 0;
function hook(): void {
	if (registered) return;
	registered = true;
	registerHooks({
		resolve(specifier, context, next) {
			const resolved = next(specifier, context);
			const version = context.parentURL ? new URL(context.parentURL).searchParams.get(parameter) : null;
			if (version === null || !resolved.url.startsWith("file:")) return resolved;
			const url = new URL(resolved.url);
			if (url.searchParams.has(parameter) || ![...directories].some((root) => url.href.startsWith(root)))
				return resolved;
			url.searchParams.set(parameter, version);
			return { ...resolved, url: url.href };
		},
	});
}
export const nodeLoader: FacetLoader = async (modules) => {
	hook();
	const version = String(++generation);
	const urls = modules.map((module) => {
		const url =
			module instanceof URL
				? new URL(module.href)
				: module.startsWith("file:")
					? new URL(module)
					: new URL(pathToFileURL(module).href);
		url.search = "";
		return url;
	});
	for (const url of urls) directories.add(new URL(".", url).href);
	const facets: Facet[] = [];
	for (const url of urls) {
		const name = url.href;
		url.searchParams.set(parameter, version);
		const imported = (await import(url.href)) as { default?: FacetDefinition };
		const definition = imported.default;
		if (definition === undefined || typeof definition.setup !== "function")
			throw new TypeError(`${name}: default export must be a facet (defineFacet)`);
		facets.push({ name, setup: definition.setup, uses: definition.uses });
	}
	return facets;
};
