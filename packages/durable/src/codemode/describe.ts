import type { CodemodeJsonSchema } from "@axi/codemode";
import { renderToolSample, toCodemodeIdentifier } from "@axi/codemode/declarations";
import type { ToolRegistration } from "../harness/types.ts";
import { MODELS_DESCRIPTION } from "./models.ts";

export type CodemodeNamespace = {
	readonly name: string;
	readonly prefix: string;
	readonly description?: string;
	readonly instructions?: string;
};
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
export function namespaceOf(name: string, namespaces: readonly CodemodeNamespace[]): CodemodeNamespace | undefined {
	return namespaces
		.filter((namespace) => name.startsWith(namespace.prefix))
		.sort((a, b) => b.prefix.length - a.prefix.length)[0];
}

export function codemodeSection(
	tools: readonly ToolRegistration[],
	namespaces: readonly CodemodeNamespace[],
	budget: number,
): string | undefined {
	if (!tools.length) return undefined;
	type Entry = { name: string; text: string; cost: number };
	type Group = { namespace: CodemodeNamespace | undefined; entries: Entry[] };
	const groups = new Map<string, Group>([["", { namespace: undefined, entries: [] }]]);
	for (const tool of tools) {
		const namespace = namespaceOf(tool.name, namespaces);
		const key = namespace === undefined ? "" : `ns:${namespace.name}`;
		const group = groups.get(key) ?? { namespace, entries: [] };
		groups.set(key, group);
		const id = toCodemodeIdentifier(tool.name);
		const text = `### \`${id}\`${id === tool.name ? "" : ` (\`${tool.name}\`)`}\n${sampleOf(tool).trim()}`;
		group.entries.push({ name: tool.name, text, cost: Math.ceil(text.length / 4) });
	}
	const ordered = [...groups.values()].sort((a, b) =>
		a.namespace === undefined ? -1 : b.namespace === undefined ? 1 : a.namespace.name.localeCompare(b.namespace.name),
	);
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
	for (const { namespace, entries } of ordered) {
		if (!entries.length) continue;
		const visible = entries.filter((entry) => selected.has(entry.name));
		if (namespace) {
			const omitted =
				visible.length === entries.length ? "" : visible.length ? " (some tools not listed)" : " (tools not listed)";
			parts.push(
				`## ${namespace.name}${omitted}${namespace.description?.trim() ? `\n${namespace.description.trim()}` : ""}`,
			);
		} else if (visible.length < entries.length)
			parts.push("Some tools are not listed: find them with `searchTools()`.");
		parts.push(...visible.map((entry) => entry.text));
	}
	return parts.join("\n\n");
}
