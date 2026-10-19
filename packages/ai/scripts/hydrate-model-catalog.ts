import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createModelDataManifest,
	groupProviderModelData,
	MODEL_DATA_MANIFEST_FILE,
	type ModelCatalogEntry,
	type ModelDataStructure,
	readModelDataProviderIds,
	record,
	validateModelDataDirectory,
} from "./model-data.ts";

export function hydrateModelCatalog(
	packageRoot: string,
	catalogPath: string,
	options: { validateOnly?: boolean } = {},
): void {
	const catalog: unknown = JSON.parse(readFileSync(catalogPath, "utf8"));
	if (!record(catalog)) throw new Error("Model catalog must be an object");
	const files: Record<string, string> = {},
		structure: ModelDataStructure = {};
	for (const provider of readModelDataProviderIds(packageRoot)) {
		const source = catalog[provider];
		if (source === undefined) throw new Error(`Model catalog is missing provider: ${provider}`);
		if (!Array.isArray(source) || !source.length)
			throw new Error(`Model catalog has no typed model list for provider: ${provider}`);
		const models: (ModelCatalogEntry & Record<string, unknown>)[] = [];
		for (const value of source) {
			if (
				!record(value) ||
				typeof value.type !== "string" ||
				typeof value.id !== "string" ||
				typeof value.api !== "string" ||
				!value.api
			)
				throw new Error(`Model catalog has an invalid entry for provider ${provider}`);
			models.push({ ...value, type: value.type, id: value.id, api: value.api });
		}
		const grouped = groupProviderModelData(provider, models);
		files[`${provider}.json`] = `${JSON.stringify(grouped.groups)}\n`;
		structure[provider] = grouped.structure;
	}
	const manifest = createModelDataManifest(structure, files, "1970-01-01T00:00:00.000Z");
	const directory = join(packageRoot, "src/providers"),
		stage = mkdtempSync(join(directory, ".catalog-"));
	try {
		const data = join(stage, "data");
		mkdirSync(data);
		for (const [filename, contents] of Object.entries(files)) writeFileSync(join(data, filename), contents);
		writeFileSync(join(data, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
		validateModelDataDirectory(structure, data);
		if (!options.validateOnly) {
			rmSync(join(directory, "data"), { recursive: true, force: true });
			renameSync(data, join(directory, "data"));
		}
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	if (process.argv.length !== 3) throw new Error("Usage: node hydrate-model-catalog.ts <catalog.json>");
	hydrateModelCatalog(join(dirname(fileURLToPath(import.meta.url)), ".."), resolve(process.argv[2]));
}
