import type { ImageContent, SystemMessage, TextContent, ThinkingContent, ToolCall } from "../types.ts";
export function contentText(
	content: string | readonly (TextContent | ImageContent | ThinkingContent | ToolCall)[],
	separator = "\n",
): string {
	return typeof content === "string"
		? content
		: content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(separator);
}
export function getSystemMessageText(message: SystemMessage): string {
	return [contentText(message.content), ...Object.values(message.sections ?? {}).filter((value) => value !== null)]
		.filter((text) => text.length)
		.join("\n\n");
}
export function renderSystemMessageUpdate(message: SystemMessage): string {
	const text = contentText(message.content);
	return [
		...(text ? [text] : []),
		...Object.entries(message.sections ?? {}).map(([name, value]) =>
			value === null
				? `Removed system prompt section "${name}".`
				: `Updated system prompt section "${name}":\n\n${value}`,
		),
	].join("\n\n");
}
