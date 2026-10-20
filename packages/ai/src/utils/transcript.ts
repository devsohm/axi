import type { Context, Message, SystemMessage, Tool, ToolReference, TranscriptContext } from "../types.ts";
import { contentText, getSystemMessageText } from "./text.ts";
export type { TranscriptContext } from "../types.ts";
export type TranscriptMessages = readonly { role: string }[];
function isSystemMessage(message: { role: string }): message is SystemMessage {
	return message.role === "system";
}
export function createInitialSystemMessage(
	systemPrompt: string | undefined,
	tools: Tool[] | undefined,
): SystemMessage | undefined {
	if (!systemPrompt?.length && !tools?.length) return undefined;
	return { role: "system", content: systemPrompt ?? "", ...(tools?.length ? { toolsAdded: tools } : {}), timestamp: 0 };
}
export function normalizeContext(context: Context): TranscriptContext {
	const head = createInitialSystemMessage(context.systemPrompt, context.tools);
	return { messages: head ? [head, ...context.messages] : context.messages } as TranscriptContext;
}
export function getInitialSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
	return messages[0]?.role === "system" ? (messages[0] as SystemMessage) : undefined;
}
export function withoutInitialSystemMessage(messages: Message[]): Message[] {
	return getInitialSystemMessage(messages) ? messages.slice(1) : messages;
}
export function getCurrentTools(messages: TranscriptMessages): Tool[] {
	const tools = new Map<string, Tool>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return [...tools.values()];
}
export function getCurrentSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
	const content: string[] = [];
	const sections = new Map<string, string>();
	let timestamp: number | undefined;
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		timestamp ??= message.timestamp;
		const text = contentText(message.content);
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
	}
	const tools = getCurrentTools(messages);
	if (timestamp === undefined && tools.length === 0) return undefined;
	return {
		role: "system",
		content: content.join("\n\n"),
		...(sections.size ? { sections: Object.fromEntries(sections) } : {}),
		...(tools.length ? { toolsAdded: tools } : {}),
		timestamp: timestamp ?? 0,
	};
}
export function getCurrentSystemPrompt(messages: TranscriptMessages): string {
	const message = getCurrentSystemMessage(messages);
	return message ? getSystemMessageText(message) : "";
}
export function collapseSystemMessages(context: TranscriptContext): TranscriptContext {
	const head = getCurrentSystemMessage(context.messages);
	const rest = context.messages.filter((message) => message.role !== "system");
	return { messages: head ? [head, ...rest] : rest } as TranscriptContext;
}
export function resolveTranscript(
	context: TranscriptContext,
	supportsMidConvoSystemMessages: boolean | undefined,
): TranscriptContext {
	return supportsMidConvoSystemMessages ? context : collapseSystemMessages(context);
}
export function toToolDeclaration(tool: Tool): Tool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters)),
		...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
	};
}
export function declarationsEqual(left: Tool, right: Tool): boolean {
	return JSON.stringify(toToolDeclaration(left)) === JSON.stringify(toToolDeclaration(right));
}
export interface ToolStateChanges {
	toolsAdded: Tool[];
	toolsRemoved: ToolReference[];
}
export function getToolStateChanges(previous: readonly Tool[], current: readonly Tool[]): ToolStateChanges {
	const before = new Map(previous.map((tool) => [tool.name, tool]));
	const after = new Map(current.map((tool) => [tool.name, tool]));
	const changed = (tool: Tool, lookup: Map<string, Tool>) => {
		const other = lookup.get(tool.name);
		return !other || !declarationsEqual(tool, other);
	};
	return {
		toolsAdded: current.filter((tool) => changed(tool, before)).map(toToolDeclaration),
		toolsRemoved: previous.filter((tool) => changed(tool, after)).map((tool) => ({ name: tool.name })),
	};
}
export function getDeclaredTools(messages: TranscriptMessages): Tool[] {
	const declarations = new Map<string, Tool>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of message.toolsAdded ?? []) declarations.set(tool.name, tool);
	}
	return [...declarations.values()];
}
export function hasToolRedefinitions(messages: TranscriptMessages): boolean {
	const declarations = new Map<string, Tool>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of message.toolsAdded ?? []) {
			const old = declarations.get(tool.name);
			if (old && !declarationsEqual(old, tool)) return true;
			declarations.set(tool.name, tool);
		}
	}
	return false;
}
export function hasNonAdditiveToolChanges(messages: TranscriptMessages): boolean {
	return lastToolReplacement(messages.filter(isSystemMessage)) >= 0;
}
function lastToolReplacement(messages: readonly SystemMessage[]): number {
	const names = new Set<string>();
	let last = -1;
	for (const [index, message] of messages.entries()) {
		if (message.toolsRemoved?.length) last = index;
		for (const tool of message.toolsAdded ?? []) {
			if (names.has(tool.name)) last = index;
			names.add(tool.name);
		}
	}
	return last;
}
export type TranscriptToolSupport = "none" | "additions" | "changes";
export interface TranscriptTools {
	requestTools: Tool[];
	foldedSystemMessages: number;
}
export function resolveTranscriptTools(messages: TranscriptMessages, support: TranscriptToolSupport): TranscriptTools {
	const updates = messages.filter(isSystemMessage);
	if (support === "changes") return { requestTools: [], foldedSystemMessages: 0 };
	const foldedSystemMessages =
		support === "none"
			? updates.length
			: Math.max(getInitialSystemMessage(messages) ? 1 : 0, lastToolReplacement(updates) + 1);
	return {
		requestTools: getCurrentTools(updates.slice(0, foldedSystemMessages)),
		foldedSystemMessages,
	};
}
