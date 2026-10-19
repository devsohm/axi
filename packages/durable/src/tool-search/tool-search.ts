import { Type } from "@axi/ai";
import { defineExtension, defineTool } from "../harness/define.ts";
import type { ToolRegistration } from "../harness/types.ts";
import { rankDocuments } from "../search.ts";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;
export type ToolSearchToolDetails = { loaded: string[] };

const parameters = Type.Object({
	query: Type.String({ description: "Search query for deferred tools." }),
	limit: Type.Optional(Type.Number({ description: "Maximum number of tools to return. Defaults to 8." })),
});
const description =
	"# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nSome of the tools, such as tools of MCP servers, may not have been provided to you upfront, and you should use this tool (`tool_search`) to search for the required tools. For MCP tool discovery, always use `tool_search`.";

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function schemaTerms(value: unknown, terms: string[]): void {
	if (!record(value)) return;
	if (typeof value.description === "string") terms.push(value.description);
	if (record(value.properties))
		for (const [key, child] of Object.entries(value.properties)) {
			terms.push(key);
			schemaTerms(child, terms);
		}
	schemaTerms(value.items, terms);
	for (const key of ["anyOf", "oneOf", "allOf"])
		if (Array.isArray(value[key])) for (const child of value[key]) schemaTerms(child, terms);
}
function document(tool: ToolRegistration): { name: string; text: string } {
	const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description];
	schemaTerms(tool.parameters, parts);
	return { name: tool.name, text: parts.filter((part) => part.trim() !== "").join(" ") };
}
export function createToolSearchTool() {
	return defineTool({
		name: TOOL_SEARCH_TOOL_NAME,
		description,
		parameters,
		callers: ["model"],
		replay: "safe",
		async execute({ query, limit }, api, context) {
			if (query.trim() === "") throw new Error("query must not be empty");
			const count = limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
			if (!Number.isInteger(count) || count <= 0) throw new Error("limit must be a positive integer");
			const tools = (await api.agent(context)).deferred;
			const loaded = rankDocuments(query, tools.map(document), count);
			let text = "No matching tools found.";
			if (loaded.length) {
				const lines = loaded.map((name) => {
					const summary = tools.find((tool) => tool.name === name)?.description ?? "";
					return `- ${name}: ${summary.trim().split(/\r?\n/)[0]}`;
				});
				text = `Loaded ${loaded.length} tool${loaded.length === 1 ? "" : "s"}. They are available from your next call:\n${lines.join("\n")}`;
			}
			const details: ToolSearchToolDetails = { loaded };
			return { output: [{ type: "text", text }], details, ...(loaded.length ? { control: { addTools: loaded } } : {}) };
		},
	});
}
export function createToolSearchExtension() {
	return defineExtension({ name: "tool-search", tools: [createToolSearchTool()] });
}
