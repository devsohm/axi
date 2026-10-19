import type { Context } from "@axi/chord";
import { NodeExecutionEnv } from "../../env/node.ts";
import { JsonlStorage, type JsonlStorageOptions } from "./storage.ts";

export { JsonlStorage, type JsonlStorageOptions } from "./storage.ts";
export function openNodeJsonlStorage(
	directory: string,
	context: Context,
	options: JsonlStorageOptions = {},
): Promise<JsonlStorage> {
	return JsonlStorage.open(directory, new NodeExecutionEnv({ cwd: process.cwd() }), context, options);
}
