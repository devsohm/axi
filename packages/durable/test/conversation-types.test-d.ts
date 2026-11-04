import type { Context } from "@axi/objects/context";
import type { Conversation, ConversationHandle, Tx } from "../src/index.ts";

export function checkConversationOperations(
	conversation: Conversation,
	handle: ConversationHandle,
	tx: Tx,
	context: Context,
): void {
	void handle.submit({ type: "continue" }, context);
	void handle.submit({ type: "write", entry: { kind: "application.note" } }, context);
	void handle.submit(tx, { type: "continue" });
	void handle.submit(tx, { type: "write", entry: { kind: "application.note" } });
	void conversation.commit(() => 42, context, { persistence: { kind: "deferred", withinMs: 10 } });
	// @ts-expect-error Continue submissions cannot carry input content.
	void handle.submit({ type: "continue", content: "invalid" }, context);
}
