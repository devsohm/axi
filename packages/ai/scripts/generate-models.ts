import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateIndividualCatalog } from "./catalog-config.ts";
import type { CatalogOutputOptions } from "./catalog-output.ts";

function options(args: string[]): CatalogOutputOptions & { strict: boolean } {
	const result = {
		strict: false,
		dataOnly: false,
		jsonOnly: false,
		pretty: false,
		jsonOutputDir: undefined as string | undefined,
	};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		switch (arg) {
			case "--strict":
				result.strict = true;
				break;
			case "--data-only":
				result.dataOnly = true;
				break;
			case "--json-only":
				result.jsonOnly = true;
				break;
			case "--pretty":
				result.pretty = true;
				break;
			case "--json-output": {
				const directory = args[++index];
				if (!directory) throw new Error("--json-output requires a directory");
				result.jsonOutputDir = resolve(directory);
				break;
			}
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (result.jsonOnly && !result.jsonOutputDir) throw new Error("--json-only requires --json-output");
	if (result.dataOnly && (result.jsonOnly || result.jsonOutputDir))
		throw new Error("--data-only cannot be combined with JSON catalog output");
	return result;
}
async function main(): Promise<void> {
	const configuration = options(process.argv.slice(2));
	let raw: unknown;
	try {
		const response = await fetch("https://models.dev/api.json");
		if (!response.ok) throw new Error(`models.dev API returned ${response.status}`);
		raw = await response.json();
		if (configuration.strict) validateIndividualCatalog(raw);
	} catch (error) {
		if (configuration.strict) throw error;
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		raw = {};
	}
	const { fetchCatalog } = await import("./catalog-sources.ts");
	const { writeCatalog } = await import("./catalog-output.ts");
	const catalog = await fetchCatalog(raw, configuration.strict);
	writeCatalog(fileURLToPath(new URL("..", import.meta.url)), catalog, configuration);
	process.stdout.write(`Generated ${Object.keys(catalog).length} provider catalogs\n`);
}
void main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
