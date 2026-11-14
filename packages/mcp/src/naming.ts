import { createHash } from "node:crypto";

export function mcpNamespace(server: string): string {
	return "mcp__" + server.replaceAll("-", "_");
}

export function mcpServerSummary(description: string | undefined, instructions: string | undefined): string {
	const selected = description?.trim() || instructions?.trim() || "";
	const newline = selected.indexOf("\n");
	return (newline < 0 ? selected : selected.slice(0, newline)).trim();
}

export function createMcpToolName(
	server: string,
	tool: string,
	isTaken: (name: string) => boolean = () => false,
): string {
	const candidate = ["mcp", server, tool].join("__").replace(/[^A-Za-z0-9_]/g, "_");
	if (candidate.length <= 64 && !isTaken(candidate)) return candidate;
	const suffix = createHash("sha256").update(server).update("\0").update(tool).digest("hex").slice(0, 8);
	return candidate.slice(0, 55) + "_" + suffix;
}
