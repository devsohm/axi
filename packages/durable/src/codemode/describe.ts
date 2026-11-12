import type { CodemodeJsonSchema } from "@axi/codemode";
import { renderToolSample, toCodemodeIdentifier } from "@axi/codemode/declarations";
import type { Extension, ToolNamespace, ToolRegistration } from "../harness/types.ts";
import { MODELS_DESCRIPTION } from "./models.ts";

export const DEFAULT_CODEMODE_INLINE_BUDGET = 3000;

export function codemodeDescription(models: boolean): string {
	return [
		'Run JavaScript that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level `await` and `return` work. No Node, file system, network, or timers.\n- `await tools.<name>({ ...args })` resolves to a string, or an object if the tool\'s declaration says so, and rejects with an Error on failure. A tool whose declaration returns an object resolves on failure too when it returned that object; check its fields. Calls still running when the script ends are cancelled.\n- The script survives a restart: it resumes where it was, without running finished calls again.\n- Optional first line: `// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}`',
		"Globals:\n- `text(value)`, `image(dataUrlOrImageBlock)`, `console.log(...)`, and top-level `return` add output; `exit()` ends the script. With several text items, each starts with a `==> text N/M <==` line, and `console` lines follow the other output in one `<console_output>` block. `image()` also saves the image to a temp file and the result names its path.\n- `store(key, value)` and `load(key)` keep JSON values across codemode calls.\n- `ALL_TOOLS`, `await searchTools(query, { limit?, namespace? })`, `await describeTool(name)`, `await describeNamespace(name)`: find tools the `codemode` section does not list.",
		...(models ? [MODELS_DESCRIPTION] : []),
		"The `codemode` section of the system prompt lists the tools scripts can call, by namespace, as far as space allows.",
	].join("\n\n");
}
export function declarationOf(tool: ToolRegistration): {
	name: string;
	description: string;
	inputSchema: CodemodeJsonSchema;
	outputSchema: CodemodeJsonSchema;
} {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters as CodemodeJsonSchema,
		outputSchema: (tool.structuredOutputSchema as CodemodeJsonSchema | undefined) ?? { type: "string" },
	};
}
export const sampleOf = (tool: ToolRegistration): string => renderToolSample(declarationOf(tool));
export function namespacesOf(extensions: readonly Extension[]): ReadonlyMap<string, ToolNamespace> {
	const claimed = new Set<string>();
	const byTool = new Map<string, ToolNamespace>();
	for (const extension of extensions) {
		for (const tool of extension.tools ?? []) {
			if (claimed.has(tool.name)) continue;
			// An owner without namespace metadata still claims the tool.
			claimed.add(tool.name);
			if (extension.namespace !== undefined) byTool.set(tool.name, extension.namespace);
		}
	}
	return byTool;
}
export function declaredNamespaces(extensions: readonly Extension[]): readonly ToolNamespace[] {
	const declared = new Map<string, ToolNamespace>();
	for (const { namespace } of extensions) {
		if (namespace !== undefined && !declared.has(namespace.name)) declared.set(namespace.name, namespace);
	}
	return [...declared.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function codemodeSection(
	tools: readonly ToolRegistration[],
	extensions: readonly Extension[],
	budget: number,
): string | undefined {
	const namespaces = declaredNamespaces(extensions);
	if (!tools.length && !namespaces.length) return undefined;
	const byTool = namespacesOf(extensions);
	type Entry = { name: string; text: string; cost: number };
	type Group = { namespace: ToolNamespace | undefined; entries: Entry[] };
	const ungrouped: Group = { namespace: undefined, entries: [] };
	const groups = new Map<string, Group>(namespaces.map((namespace) => [namespace.name, { namespace, entries: [] }]));
	for (const tool of tools) {
		const namespace = byTool.get(tool.name);
		const group = namespace === undefined ? ungrouped : groups.get(namespace.name)!;
		const id = toCodemodeIdentifier(tool.name);
		const text = `### \`${id}\`${id === tool.name ? "" : ` (\`${tool.name}\`)`}\n${sampleOf(tool).trim()}`;
		group.entries.push({ name: tool.name, text, cost: Math.ceil(text.length / 4) });
	}
	const ordered = [ungrouped, ...groups.values()];
	const selected = new Set<string>();
	let queues = ordered
		.map((group) => [...group.entries].sort((a, b) => a.cost - b.cost))
		.filter((queue) => queue.length > 0);
	while (queues.length)
		queues = queues.filter((queue) => {
			const next = queue[0]!;
			if (next.cost > budget) return false;
			budget -= next.cost;
			selected.add(next.name);
			queue.shift();
			return queue.length > 0;
		});
	const parts = ["Tools scripts can call (`await tools.<name>(args)`):"];
	if (selected.size < tools.length) parts.push("Some tools are not listed: find them with `searchTools()`.");
	for (const { namespace, entries } of ordered) {
		const visible = entries.filter((entry) => selected.has(entry.name));
		if (namespace !== undefined) parts.push(`## ${namespace.name}\n${namespace.description.trim()}`);
		parts.push(...visible.map((entry) => entry.text));
	}
	return parts.join("\n\n");
}
