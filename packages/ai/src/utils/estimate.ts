import type { ImageContent, Message, TextContent, TranscriptContext, Usage } from "../types.ts";
import { getSystemMessageText } from "./text.ts";
export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}
function json(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 3.5);
}
export function estimateTextAndImageContentTokens(content: string | (TextContent | ImageContent)[]): number {
	if (typeof content === "string") return estimateTextTokens(content);
	let size = 0;
	for (const item of content) size += item.type === "text" ? item.text.length : 4800;
	return Math.ceil(size / 3.5);
}
function toolTokens(tools: readonly unknown[] | undefined): number {
	return tools?.length ? estimateTextTokens(json(tools)) : 0;
}
export function estimateMessageTokens(message: Message): number {
	if (message.role === "user" || message.role === "toolResult")
		return estimateTextAndImageContentTokens(message.content);
	if (message.role === "system") {
		return (
			estimateTextTokens(getSystemMessageText(message)) +
			toolTokens(message.toolsAdded) +
			toolTokens(message.toolsRemoved)
		);
	}
	let size = 0;
	for (const part of message.content) {
		if (part.type === "text") size += part.text.length;
		else if (part.type === "thinking") size += part.thinking.length;
		else size += part.name.length + json(part.arguments).length;
	}
	return Math.ceil(size / 3.5);
}
export function estimateContextTokens(context: TranscriptContext | readonly Message[]): ContextUsageEstimate {
	const messages = "messages" in context ? context.messages : context;
	let latest = -Infinity;
	let selected: { usage: Usage; index: number } | undefined;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (
			message.role === "assistant" &&
			message.timestamp >= latest &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error" &&
			calculateContextTokens(message.usage) > 0
		) {
			selected = { usage: message.usage, index };
		}
		latest = Math.max(latest, message.timestamp);
	}
	if (selected !== undefined) {
		const usageTokens = calculateContextTokens(selected.usage);
		let trailingTokens = 0;
		for (let index = selected.index + 1; index < messages.length; index++)
			trailingTokens += estimateMessageTokens(messages[index]);
		return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: selected.index };
	}
	let tokens = 0;
	for (const message of messages) tokens += estimateMessageTokens(message);
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}
