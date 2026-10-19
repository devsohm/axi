import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
export type CodemodeWasmModule = object;
const compiled = new Map<string, Promise<CodemodeWasmModule>>();
export function loadQuickJSWasm(path?: string): Promise<CodemodeWasmModule> {
	path ??= createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm");
	const found = compiled.get(path);
	if (found) return found;
	const compiler = globalThis.WebAssembly;
	const result = readFile(path)
		.then((bytes) => compiler.compile(bytes))
		.catch((error) => {
			compiled.delete(path);
			throw error;
		});
	compiled.set(path, result);
	return result;
}
