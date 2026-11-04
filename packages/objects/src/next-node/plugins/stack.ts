import { SourceMap } from "node:module";
import { basename, join } from "node:path";

type ScriptMapping = { readonly sourceMap: SourceMap; readonly directory: string; owners: number };
const mappings = new Map<string, ScriptMapping>();
const releaseMapping = new FinalizationRegistry<string>((file) => {
	const entry = mappings.get(file);
	if (entry && --entry.owners === 0) mappings.delete(file);
});

export function inlineSourceMap(source: string): SourceMap | undefined {
	const match = /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/.exec(source);
	return match ? new SourceMap(JSON.parse(Buffer.from(match[1], "base64").toString("utf8"))) : undefined;
}
export function registerScript(file: string, source: string, directory: string, owner: object): void {
	let entry = mappings.get(file);
	if (!entry) {
		const sourceMap = inlineSourceMap(source);
		if (!sourceMap) return;
		entry = { sourceMap, directory, owners: 0 };
		mappings.set(file, entry);
	}
	entry.owners++;
	releaseMapping.register(owner, file);
}
export function mapStack(error: unknown): string {
	const stack = error instanceof Error ? error.stack : undefined;
	if (stack === undefined) return String(error);
	return stack.replace(/([^\s()]+):(\d+):(\d+)/g, (position, file: string, line: string, column: string) => {
		const registered = mappings.get(file);
		const mapped = registered?.sourceMap.findEntry(Number(line) - 1, Number(column) - 1);
		if (!registered || !mapped || !("originalSource" in mapped)) return position;
		return `${join(basename(registered.directory), mapped.originalSource).replaceAll("\\", "/")}:${mapped.originalLine + 1}:${mapped.originalColumn + 1}`;
	});
}
