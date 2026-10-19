export interface ContentAnnotations {
	audience?: ("user" | "assistant")[];
	priority?: number;
	lastModified?: string;
}
interface BlockMetadata {
	annotations?: ContentAnnotations;
	_meta?: Record<string, unknown>;
}
export interface TextContent extends BlockMetadata {
	type: "text";
	text: string;
}
export interface ImageContent extends BlockMetadata {
	type: "image";
	data: string;
	mimeType: string;
}
export interface AudioContent extends BlockMetadata {
	type: "audio";
	data: string;
	mimeType: string;
}
export interface ResourceLinkContent extends BlockMetadata {
	type: "resource_link";
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	size?: number;
}
interface ResourceContents {
	uri: string;
	mimeType?: string;
	_meta?: Record<string, unknown>;
}
export interface TextResourceContents extends ResourceContents {
	text: string;
}
export interface BlobResourceContents extends ResourceContents {
	blob: string;
}
export interface EmbeddedResourceContent extends BlockMetadata {
	type: "resource";
	resource: TextResourceContents | BlobResourceContents;
}
export type ContentBlock = TextContent | ImageContent | AudioContent | ResourceLinkContent | EmbeddedResourceContent;
export interface CallToolResult {
	content: ContentBlock[];
	structuredContent?: unknown;
	isError?: boolean;
	_meta?: Record<string, unknown>;
}
export type LlmContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
function convert(block: ContentBlock): LlmContent {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };
		case "image":
			return { type: "image", data: block.data, mimeType: block.mimeType };
		case "audio":
			return { type: "text", text: `[audio ${block.mimeType} omitted]` };
		case "resource_link":
			return { type: "text", text: `${block.name}: ${block.uri}` };
		case "resource": {
			const value = block.resource;
			if ("text" in value) return { type: "text", text: value.text };
			if (value.mimeType?.startsWith("image/")) return { type: "image", data: value.blob, mimeType: value.mimeType };
			return { type: "text", text: `[binary resource ${value.uri} (${value.mimeType ?? "unknown type"}) omitted]` };
		}
		default: {
			const unreachable: never = block;
			return { type: "text", text: `[unsupported MCP content ${(unreachable as { type: string }).type}]` };
		}
	}
}
export function toLlmContent(result: Pick<CallToolResult, "content" | "structuredContent">): LlmContent[] {
	const output = (result.content ?? []).map(convert);
	if (!output.length && result.structuredContent !== undefined)
		output.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
	return output;
}
