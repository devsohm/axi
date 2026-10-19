import { fileURLToPath } from "node:url";
import { validateGeneratedModelData } from "./model-data.ts";
try {
	validateGeneratedModelData(fileURLToPath(new URL("..", import.meta.url)));
	process.stdout.write("Model catalogs are valid.\n");
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
