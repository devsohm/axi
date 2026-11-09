import type { Message } from "../types.ts";
export function inferCopilotInitiator(messages: Message[]): "user" | "agent" {
	const last = messages.at(-1);
	return last && last.role !== "user" ? "agent" : "user";
}
export function hasCopilotVisionInput(messages: Message[]): boolean {
	return messages.some(
		(message) =>
			(message.role === "user" || message.role === "toolResult") &&
			Array.isArray(message.content) &&
			message.content.some((block) => block.type === "image"),
	);
}
export function buildCopilotDynamicHeaders({
	messages,
	hasImages,
}: {
	messages: Message[];
	hasImages: boolean;
}): Record<string, string> {
	return {
		"X-Initiator": inferCopilotInitiator(messages),
		"Openai-Intent": "conversation-edits",
		...(hasImages ? { "Copilot-Vision-Request": "true" } : {}),
	};
}
