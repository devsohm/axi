import type { ConversationId } from "./types.ts";

export class ConversationBusy extends Error {
	readonly conversationId: ConversationId;
	constructor(conversationId: ConversationId) {
		super(`Conversation ${conversationId} is busy`);
		this.name = "ConversationBusy";
		this.conversationId = conversationId;
	}
}

export class StorageRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StorageRequestError";
	}
}

export class ReadAfterWrite extends Error {
	constructor(method: string) {
		super(`Tx.${method}() cannot read tables after the first table write`);
		this.name = "ReadAfterWrite";
	}
}
export class SessionFailed extends Error {
	constructor(cause: unknown) {
		super("Session failed after a storage error; close and reopen it", { cause });
		this.name = "SessionFailed";
	}
}
export function errorMessage(value: unknown): string {
	if (value instanceof Error) return value.message;
	try {
		return String(value);
	} catch {
		return Object.prototype.toString.call(value);
	}
}
