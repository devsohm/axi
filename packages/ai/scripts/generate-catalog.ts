import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateGeneratedModelData } from "./model-data.ts";

export function generateCatalog(root = fileURLToPath(new URL("..", import.meta.url))): void {
	const directory = join(root, "src/providers");
	const providers = readdirSync(join(directory, "data"))
		.filter((file) => file.endsWith(".json") && !file.startsWith("."))
		.map((file) => file.slice(0, -5))
		.sort();
	writeCatalogTypes(root, providers);
	validateGeneratedModelData(root);
	process.stdout.write(`${providers.length} catalogs validated\n`);
}
export function writeCatalogTypes(root: string, providers: readonly string[]): void {
	const directory = join(root, "src/providers");
	for (const file of readdirSync(directory)) {
		if (file.endsWith(".models.ts") && !providers.includes(file.slice(0, -10))) rmSync(join(directory, file));
	}
	const constant = (id: string) => id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
	const kinds = ["", "IMAGE_", "CLASSIFIER_"];
	const functions = ["Chat", "Image", "Classifier"];
	const imports: string[] = [];
	for (const id of providers) {
		const prefix = constant(id),
			names = kinds.map((kind) => `${prefix}_${kind}MODELS`);
		const lines = [
			`import data from "./data/${id}.json" with { type: "json" };`,
			`import {\n\tflattenChatModelCatalog,\n\tflattenImageModelCatalog,\n\tflattenClassifierModelCatalog,\n} from "../model-catalog.ts";`,
			...names.map(
				(name, index) => `export const ${name} = flatten${functions[index]}ModelCatalog(${JSON.stringify(id)}, data);`,
			),
		];
		writeFileSync(join(directory, `${id}.models.ts`), `${lines.join("\n")}\n`);
		imports.push(`import {\n${names.map((name) => `\t${name},`).join("\n")}\n} from "./providers/${id}.models.ts";`);
	}
	const tables = kinds.map((kind) => {
		const name = `${kind}MODELS`;
		return `export const ${name} = {\n${providers.map((id) => `\t${JSON.stringify(id)}: ${constant(id)}_${name},`).join("\n")}\n} as const;`;
	});
	writeFileSync(join(root, "src/models.generated.ts"), `${imports.join("\n")}\n\n${tables.join("\n\n")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) generateCatalog();
