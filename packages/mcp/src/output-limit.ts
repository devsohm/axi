import type { LlmContent } from "./protocol/content.ts";

export const MCP_OUTPUT_MAX_BYTES = 20480;
export type McpOutputSaver = (data: string | Uint8Array, extension: string) => Promise<string>;
export interface LimitedMcpContent {
	content: LlmContent[];
	fullOutputPath?: string;
}

export async function limitMcpContent(content: LlmContent[], saveOutput?: McpOutputSaver): Promise<LimitedMcpContent> {
	const text = content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	const bytes = Buffer.from(text);
	if (bytes.byteLength <= MCP_OUTPUT_MAX_BYTES) return { content };
	let start = MCP_OUTPUT_MAX_BYTES / 2,
		end = bytes.byteLength - MCP_OUTPUT_MAX_BYTES / 2;
	while ((bytes[start]! & 192) === 128) start--;
	while ((bytes[end]! & 192) === 128) end++;
	const omitted = [...bytes.subarray(start, end).toString()].length;
	let suffix = "",
		fullOutputPath: string | undefined;
	if (saveOutput) {
		try {
			fullOutputPath = await saveOutput(text, ".txt");
			suffix = `\n\n[Full output: ${fullOutputPath} (read it with offset/limit)]`;
		} catch (error) {
			suffix = `\n\n[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
		}
	}
	const lines = text.split("\n").length - Number(text.endsWith("\n"));
	const excerpt = bytes.subarray(0, start).toString() + `…${omitted} chars truncated…` + bytes.subarray(end).toString();
	return {
		content: [
			{
				type: "text",
				text: `Warning: truncated output (original token count: ${Math.ceil(bytes.length / 4)})\nTotal output lines: ${lines}\n\n${excerpt}${suffix}`,
			},
			...content.filter((block) => block.type === "image"),
		],
		...(fullOutputPath ? { fullOutputPath } : {}),
	};
}
