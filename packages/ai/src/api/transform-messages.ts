import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
export interface SplitErrorToolResult {
	content: TextContent[];
	caption: string;
	images: ImageContent[];
}
function replaceImages(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const output: TextContent[] = [];
	let repeated = false;
	for (const block of content) {
		if (block.type === "image") {
			if (!repeated) output.push({ type: "text", text: placeholder });
			repeated = true;
		} else {
			output.push(block);
			repeated = block.text === placeholder;
		}
	}
	return output;
}
export function splitErrorToolResultImages(message: ToolResultMessage): SplitErrorToolResult | undefined {
	if (!message.isError) return undefined;
	const images = message.content.filter((block): block is ImageContent => block.type === "image");
	return images.length
		? {
				images,
				content: replaceImages(message.content, "(image attached after the tool results)"),
				caption: `Images from the error result of tool call ${message.toolCallId} (${message.toolName}):`,
			}
		: undefined;
}
export function transformMessages<A extends Api>(
	messages: Message[],
	model: Model<A>,
	normalizeToolCallId?: (id: string, model: Model<A>, source: AssistantMessage) => string,
): Message[] {
	const ids = new Map<string, string>();
	const normalized: Message[] = messages.map((message) => {
		let input = message.content == null ? { ...message, content: [] } : message;
		if (!model.input.includes("image")) {
			if (input.role === "user" && Array.isArray(input.content))
				input = { ...input, content: replaceImages(input.content, "(image omitted: model does not support images)") };
			else if (input.role === "toolResult")
				input = {
					...input,
					content: replaceImages(input.content, "(tool image omitted: model does not support images)"),
				};
		}
		if (input.role === "toolResult") {
			const id = ids.get(input.toolCallId);
			return id && id !== input.toolCallId ? { ...input, toolCallId: id } : input;
		}
		if (input.role !== "assistant") return input;
		const same = input.provider === model.provider && input.api === model.api && input.model === model.id;
		const content: AssistantMessage["content"] = [];
		for (const block of input.content) {
			if (block.type === "thinking") {
				if (same && (block.redacted || block.thinkingSignature || block.thinking?.trim())) content.push(block);
			} else if (block.type === "text") content.push(same ? block : { type: "text", text: block.text });
			else {
				let call = block;
				if (!same && block.thoughtSignature) {
					call = { ...block };
					delete call.thoughtSignature;
				}
				if (!same && normalizeToolCallId) {
					const id = normalizeToolCallId(block.id, model, input);
					if (id !== block.id) {
						ids.set(block.id, id);
						call = { ...call, id };
					}
				}
				content.push(call);
			}
		}
		return { ...input, content };
	});
	const result: Message[] = [],
		held: Message[] = [];
	let pending: ToolCall[] = [],
		answered = new Set<string>();
	const finish = () => {
		for (const call of pending)
			if (!answered.has(call.id))
				result.push({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: "No result provided" }],
					isError: true,
					timestamp: Date.now(),
				});
		pending = [];
		answered = new Set();
		result.push(...held);
		held.length = 0;
	};
	for (const message of normalized) {
		switch (message.role) {
			case "assistant":
				finish();
				if (message.stopReason === "error" || message.stopReason === "aborted") break;
				pending = message.content.filter((block): block is ToolCall => block.type === "toolCall");
				result.push(message);
				break;
			case "toolResult":
				answered.add(message.toolCallId);
				result.push(message);
				break;
			case "system":
				if (pending.length) held.push(message);
				else result.push(message);
				break;
			case "user":
				finish();
				result.push(message);
				break;
			default:
				result.push(message);
		}
	}
	finish();
	return result;
}
