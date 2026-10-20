import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { assembleCatalog } from "./catalog-generation.ts";
import { writeCatalogTypes } from "./generate-catalog.ts";
import {
	createModelDataManifest,
	groupProviderModelData,
	MODEL_DATA_MANIFEST_FILE,
	type ModelDataStructure,
	readModelDataProviderIds,
	validateGeneratedModelData,
	validateModelDataDirectory,
} from "./model-data.ts";
export interface CatalogOutputOptions {
	dataOnly: boolean;
	jsonOnly: boolean;
	jsonOutputDir?: string;
	pretty: boolean;
}
export function writeCatalog(
	root: string,
	catalog: ReturnType<typeof assembleCatalog>,
	options: CatalogOutputOptions,
): void {
	const encode = (value: unknown) => `${JSON.stringify(value, null, options.pretty ? 2 : undefined)}\n`;
	const ids = Object.keys(catalog).sort(),
		included = options.dataOnly ? readModelDataProviderIds(root) : ids;
	const missing = included.filter((id) => !catalog[id]);
	if (missing.length) throw new Error(`Cannot hydrate missing providers: ${missing.join(", ")}`);
	const structure: ModelDataStructure = {},
		files: Record<string, string> = {};
	for (const id of included) {
		const grouped = groupProviderModelData(id, catalog[id]);
		structure[id] = grouped.structure;
		files[`${id}.json`] = encode(grouped.groups);
	}
	if (!options.jsonOnly) {
		const providers = join(root, "src/providers");
		const current = join(providers, "data"),
			aggregator = join(root, "src/models.generated.ts");
		const stage = mkdtempSync(join(providers, ".catalog-output-")),
			next = join(stage, "data"),
			previous = join(stage, "previous");
		let restoreTypes: (() => void) | undefined;
		try {
			mkdirSync(next);
			for (const [name, content] of Object.entries(files)) writeFileSync(join(next, name), content);
			writeFileSync(
				join(next, MODEL_DATA_MANIFEST_FILE),
				encode(createModelDataManifest(structure, files, new Date().toISOString())),
			);
			validateModelDataDirectory(structure, next);
			if (!options.dataOnly) {
				const backup = new Map(
					readdirSync(providers)
						.filter((name) => name.endsWith(".models.ts"))
						.map((name) => [name, readFileSync(join(providers, name), "utf8")]),
				);
				const previousTypes = readFileSync(aggregator, "utf8");
				restoreTypes = () => {
					for (const name of readdirSync(providers)) if (name.endsWith(".models.ts")) rmSync(join(providers, name));
					for (const [name, content] of backup) writeFileSync(join(providers, name), content);
					writeFileSync(aggregator, previousTypes);
				};
				writeCatalogTypes(root, ids);
			}
			const hadPrevious = existsSync(current);
			if (hadPrevious) renameSync(current, previous);
			try {
				renameSync(next, current);
				validateGeneratedModelData(root);
			} catch (error) {
				rmSync(current, { recursive: true, force: true });
				if (hadPrevious && existsSync(previous)) renameSync(previous, current);
				throw error;
			}
			restoreTypes = undefined;
		} catch (error) {
			restoreTypes?.();
			throw error;
		} finally {
			rmSync(stage, { recursive: true, force: true });
		}
	}
	if (options.jsonOutputDir) {
		rmSync(options.jsonOutputDir, { recursive: true, force: true });
		const directory = join(options.jsonOutputDir, "providers");
		mkdirSync(directory, { recursive: true });
		const chats = Object.fromEntries(
			ids.map((id) => [
				id,
				Object.fromEntries(catalog[id].filter((model) => model.type === "chat").map((model) => [model.id, model])),
			]),
		);
		writeFileSync(join(options.jsonOutputDir, "models.json"), encode(chats));
		writeFileSync(join(options.jsonOutputDir, "models.all.json"), encode(catalog));
		writeFileSync(join(options.jsonOutputDir, "providers.json"), encode(ids));
		for (const id of ids) {
			writeFileSync(join(directory, `${id}.json`), encode(chats[id]));
			writeFileSync(join(directory, `${id}.all.json`), encode(catalog[id]));
		}
	}
}
