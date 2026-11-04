import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const MODEL_DATA_SCHEMA_VERSION = 6;
export const MODEL_DATA_MANIFEST_FILE = ".manifest.json";
export type ModelDataStructure = Record<string, Record<string, string>>;
export interface ModelDataManifest {
	schemaVersion: number;
	generatedAt: string;
	structureHash: string;
	files: Record<string, string>;
}
export interface ModelCatalogEntry {
	type: string;
	id: string;
	api: string;
}
export const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const sorted = <T>(entries: Iterable<readonly [string, T]>): Record<string, T> =>
	Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
export const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function difference(expected: Iterable<string>, actual: Iterable<string>): string {
	const left = new Set(expected),
		right = new Set(actual);
	const missing = [...left].filter((key) => !right.has(key)).sort();
	const extra = [...right].filter((key) => !left.has(key)).sort();
	return [missing.length ? `missing: ${missing.join(", ")}` : "", extra.length ? `extra: ${extra.join(", ")}` : ""]
		.filter(Boolean)
		.join("; ");
}
export function assertExactModelIds(label: string, expected: Iterable<string>, actual: Iterable<string>): void {
	const delta = difference(expected, actual);
	if (delta) throw new Error(`${label} model IDs do not match (${delta})`);
}
export function readModelDataProviderIds(packageRoot: string): string[] {
	const source = readFileSync(join(packageRoot, "src/models.generated.ts"), "utf8");
	const providers = [...source.matchAll(/from ["']\.\/providers\/([^/"']+)\.models\.ts["']/g)]
		.map((match) => match[1])
		.sort();
	const file = join(packageRoot, "src/models.generated.ts");
	if (!providers.length) throw new Error(`No generated provider imports found in ${file}`);
	if (new Set(providers).size !== providers.length)
		throw new Error(`Generated model aggregator contains duplicate provider imports: ${file}`);
	return providers;
}
function jsonObject(file: string, description = file): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`${description} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!record(value)) throw new Error(`${description} must contain a JSON object`);
	return value;
}
export function readModelDataStructure(packageRoot: string): ModelDataStructure {
	const root = join(packageRoot, "src/providers"),
		ids = readModelDataProviderIds(packageRoot);
	const delta = difference(
		ids.map((id) => `${id}.models.ts`),
		readdirSync(root).filter((file) => file.endsWith(".models.ts")),
	);
	if (delta) throw new Error(`Generated model aggregator and provider shards do not match (${delta})`);
	return sorted(
		ids.map((id) => {
			const entries = new Map<string, string>();
			const file = join(root, "data", `${id}.json`);
			for (const [api, group] of Object.entries(jsonObject(file, `${id}.json`))) {
				if (!record(group)) throw new Error(`${file} API group ${JSON.stringify(api)} must be an object`);
				for (const key of Object.keys(group)) {
					if (entries.has(key)) throw new Error(`${file} contains ${key} in more than one API group`);
					entries.set(key, api);
				}
			}
			if (!entries.size) throw new Error(`${file} contains no generated model data`);
			return [id, sorted(entries)] as const;
		}),
	);
}
export function modelDataStructureHash(structure: ModelDataStructure): string {
	return hash(
		JSON.stringify(
			sorted(Object.entries(structure).map(([id, entries]) => [id, sorted(Object.entries(entries))] as const)),
		),
	);
}
export function createModelDataManifest(
	structure: ModelDataStructure,
	files: Readonly<Record<string, string>>,
	generatedAt: string,
): ModelDataManifest {
	return {
		schemaVersion: MODEL_DATA_SCHEMA_VERSION,
		generatedAt,
		structureHash: modelDataStructureHash(structure),
		files: sorted(Object.entries(files).map(([file, text]) => [file, hash(text)] as const)),
	};
}
function validateModel(value: unknown, provider: string, key: string, api: string, errors: string[]): void {
	const id = key.slice(key.indexOf(":") + 1),
		label = `${provider}/${id}`;
	if (!record(value)) {
		errors.push(`${label} must be an object`);
		return;
	}
	for (const [field, expected] of Object.entries({ id, provider, api })) {
		if (value[field] !== expected)
			errors.push(`${label} has ${field} ${JSON.stringify(value[field])}, expected ${JSON.stringify(expected)}`);
	}
	const modality = (input: unknown) =>
		Array.isArray(input) && input.length > 0 && input.every((item) => item === "text" || item === "image");
	if (typeof value.name !== "string" || !value.name) errors.push(`${label} has no model name`);
	if (typeof value.baseUrl !== "string") errors.push(`${label} has no baseUrl string`);
	if (!modality(value.input)) errors.push(`${label} has invalid input modalities`);
	if (value.type === "image") {
		if (!modality(value.output) || !Array.isArray(value.output) || !value.output.includes("image"))
			errors.push(`${label} has invalid output modalities`);
	} else {
		if (value.output !== undefined) errors.push(`${label} has unsupported output modalities`);
	}
	if (value.type === "chat" || value.type === "classifier") {
		if (value.type === "chat" && typeof value.reasoning !== "boolean") errors.push(`${label} has no reasoning boolean`);
		const fields = value.type === "chat" ? ["contextWindow", "maxTokens"] : ["contextWindow"];
		for (const field of fields)
			if (typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] <= 0)
				errors.push(`${label} has invalid ${field}`);
	} else if (value.type !== "image")
		errors.push(`${label} has type ${JSON.stringify(value.type)}, expected "chat", "image", or "classifier"`);
	if (!record(value.cost)) errors.push(`${label} has invalid cost metadata`);
	else
		for (const field of ["input", "output", "cacheRead", "cacheWrite"])
			if (typeof value.cost[field] !== "number" || !Number.isFinite(value.cost[field]))
				errors.push(`${label} has invalid cost.${field}`);
	if (key !== `${String(value.type)}:${String(value.id)}`)
		errors.push(`${provider}/${key} has mismatched type/id identity`);
}
export function validateModelDataDirectory(structure: ModelDataStructure, directory: string): void {
	if (!existsSync(directory) || !statSync(directory).isDirectory())
		throw new Error(`Generated model data directory does not exist: ${directory}`);
	const errors: string[] = [];
	const load = (file: string, description: string) => {
		try {
			return jsonObject(file, description);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
			return undefined;
		}
	};
	const filenames = Object.keys(structure).map((id) => `${id}.json`);
	const fileDifference = difference(
		filenames,
		readdirSync(directory).filter((file) => file.endsWith(".json") && file !== MODEL_DATA_MANIFEST_FILE),
	);
	if (fileDifference) errors.push(`provider data files do not match the generated catalog (${fileDifference})`);
	const manifest = load(join(directory, MODEL_DATA_MANIFEST_FILE), "model data manifest");
	if (manifest?.schemaVersion !== MODEL_DATA_SCHEMA_VERSION)
		errors.push(
			`model data schema is ${JSON.stringify(manifest?.schemaVersion)}, expected ${MODEL_DATA_SCHEMA_VERSION}`,
		);
	if (typeof manifest?.generatedAt !== "string" || Number.isNaN(Date.parse(manifest.generatedAt)))
		errors.push("model data manifest has an invalid generation timestamp");
	if (manifest?.structureHash !== modelDataStructureHash(structure))
		errors.push("model data generation stamp does not match the generated catalog");
	const hashes = record(manifest?.files) ? manifest.files : undefined;
	if (!hashes) errors.push("model data manifest has no file hashes");
	else {
		const delta = difference(filenames, Object.keys(hashes));
		if (delta) errors.push(`manifest file hashes do not match provider data files (${delta})`);
	}
	for (const [provider, expected] of Object.entries(structure)) {
		const file = `${provider}.json`,
			filename = join(directory, file);
		if (!existsSync(filename)) continue;
		if (hashes && hashes[file] !== hash(readFileSync(filename, "utf8")))
			errors.push(`${file} does not match its manifest hash`);
		const groups = load(filename, file);
		if (!groups) continue;
		const actual = new Map<string, string>();
		for (const [api, group] of Object.entries(groups)) {
			if (!record(group)) {
				errors.push(`${file} API group ${JSON.stringify(api)} must be an object`);
				continue;
			}
			for (const [key, model] of Object.entries(group)) {
				if (actual.has(key)) {
					errors.push(`${provider}/${key} appears in more than one API group`);
					continue;
				}
				actual.set(key, api);
				validateModel(model, provider, key, api, errors);
			}
		}
		const delta = difference(Object.keys(expected), actual.keys());
		if (delta) errors.push(`${file} model IDs do not match the generated catalog (${delta})`);
		for (const [key, api] of Object.entries(expected))
			if (actual.has(key) && actual.get(key) !== api)
				errors.push(
					`${provider}/${key} is grouped under API ${JSON.stringify(actual.get(key))}, expected ${JSON.stringify(api)}`,
				);
	}
	if (errors.length)
		throw new Error(
			`Invalid generated model data:\n${errors
				.slice(0, 30)
				.map((error) => `  - ${error}`)
				.join("\n")}${errors.length > 30 ? `\n  ... and ${errors.length - 30} more` : ""}`,
		);
}
export function validateGeneratedModelData(packageRoot: string): void {
	validateModelDataDirectory(readModelDataStructure(packageRoot), join(packageRoot, "src/providers/data"));
}
export function groupProviderModelData<T extends ModelCatalogEntry>(
	provider: string,
	models: readonly T[],
): { groups: Record<string, Record<string, T>>; structure: Record<string, string> } {
	const groups: Record<string, Record<string, T>> = {},
		structure: Record<string, string> = {};
	for (const api of [...new Set(models.map((model) => model.api))].sort()) {
		const group: Record<string, T> = {};
		for (const model of models.filter((model) => model.api === api)) {
			const key = `${model.type}:${model.id}`;
			if (Object.hasOwn(group, key)) throw new Error(`${provider}/${key} has duplicate ${api} catalog entries`);
			group[key] = model;
			structure[key] = api;
		}
		groups[api] = group;
	}
	return { groups, structure };
}
