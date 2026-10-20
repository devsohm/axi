import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
export interface NativeModuleCandidateOptions {
	moduleUrl?: string;
	execPath?: string;
	resolvePackage?: (specifier: string) => string;
}
export function getNativeModuleCandidates(nativePath: string, options: NativeModuleCandidateOptions = {}): string[] {
	const paths = new Set<string>(),
		directory = dirname(fileURLToPath(options.moduleUrl ?? import.meta.url));
	try {
		paths.add(join(dirname((options.resolvePackage ?? require.resolve)("@axi/tui")), "..", nativePath));
	} catch {}
	for (const path of [
		join(directory, "..", nativePath),
		join(directory, nativePath),
		join(dirname(options.execPath ?? process.execPath), nativePath),
	])
		paths.add(path);
	return [...paths];
}
