import type { Context } from "@axi/objects/context";
import { addressId } from "../documents.ts";
import type * as T from "../types.ts";

export const taskKey = (id: T.TaskId): string => `task:${id}`;
export const conversationKey = (id: T.ConversationId): string => `conv:${id}`;
export const entryKey = (id: T.EntryId): string => `entry:${id}`;
export const appendKey = (id: T.ConversationId): string => `entry-append:${id}`;
export const submissionKey = (id: T.SubmissionId): string => `sub:${id}`;
export const requestKey = (id: T.ConversationId, request: string): string => `req:${id}:${request}`;
export const documentKey = (address: string): string => `doc:${address}`;
export const incarnationKey = (id: T.DocumentId): string => `docid:${id}`;
export const ownedKey = (node: T.TaskId | string): string => `owned:${node}`;
export const ROOTS_KEY = "roots",
	INTENT_KEY = "intent",
	ALL_KEYS = "*";
export function scopeKey(scope: T.DocumentRecord["scope"]): string {
	switch (scope.kind) {
		case "session":
			return "docscope:session";
		case "conversation":
			return `docscope:c${scope.conversationId}`;
		case "task":
			return `docscope:t${scope.taskId}`;
	}
}
export function tableKeys(writes: readonly T.StorageWrite[], keys: string[]): void {
	for (const write of writes)
		switch (write.type) {
			case "conversation":
				keys.push(conversationKey(write.value.id));
				break;
			case "entry":
				keys.push(entryKey(write.value.id), appendKey(write.value.conversationId));
				break;
			case "task":
				keys.push(taskKey(write.value.id));
				break;
			case "submission":
				keys.push(submissionKey(write.value.id));
				if (write.value.requestId !== undefined)
					keys.push(requestKey(write.value.conversationId, write.value.requestId));
				break;
		}
}

export class GatedStorage implements T.Storage {
	readonly #source: T.Storage;
	readonly #touch: (key: string) => Promise<void> | undefined;
	constructor(storage: T.Storage, touch: (key: string) => Promise<void> | undefined) {
		this.#source = storage;
		this.#touch = touch;
	}
	commit: T.Storage["commit"] = (...args) => this.#source.commit(...args);
	mintId: T.Storage["mintId"] = () => this.#source.mintId();
	close: T.Storage["close"] = (...args) => this.#source.close(...args);
	conversation: T.Storage["conversation"] = (id, ...rest) =>
		this.#after(conversationKey(id), () => this.#source.conversation(id, ...rest));
	task: T.Storage["task"] = (id, ...rest) => this.#after(taskKey(id), () => this.#source.task(id, ...rest));
	submission: T.Storage["submission"] = (id, ...rest) =>
		this.#after(submissionKey(id), () => this.#source.submission(id, ...rest));
	scanConversations: T.Storage["scanConversations"] = (...args) =>
		this.#after(ALL_KEYS, () => this.#source.scanConversations(...args));
	scanTasks: T.Storage["scanTasks"] = (...args) => this.#after(ALL_KEYS, () => this.#source.scanTasks(...args));
	scanSubmissions: T.Storage["scanSubmissions"] = (...args) =>
		this.#after(ALL_KEYS, () => this.#source.scanSubmissions(...args));
	submissionByRequest: T.Storage["submissionByRequest"] = (id, request, ...rest) =>
		this.#after(requestKey(id, request), () => this.#source.submissionByRequest(id, request, ...rest));
	findDocument: T.Storage["findDocument"] = (address, ...rest) =>
		this.#after(documentKey(addressId(address)), () => this.#source.findDocument(address, ...rest));
	document: T.Storage["document"] = (id, ...rest) =>
		this.#after(incarnationKey(id), () => this.#source.document(id, ...rest));
	scanDocuments: T.Storage["scanDocuments"] = (query, ...rest) =>
		this.#after(scopeKey(query.scope), () => this.#source.scanDocuments(query, ...rest));
	scanEntries: T.Storage["scanEntries"] = (query, ...rest) =>
		this.#entries(query.conversationId, () => this.#source.scanEntries(query, ...rest));
	findLatestHeadMarker: T.Storage["findLatestHeadMarker"] = (id, ...rest) =>
		this.#entries(id, () => this.#source.findLatestHeadMarker(id, ...rest));
	entry(id: T.EntryId, context: Context): ReturnType<T.Storage["entry"]>;
	entry(conversation: T.ConversationId, id: T.EntryId, context: Context): ReturnType<T.Storage["entry"]>;
	entry(...args: [T.EntryId, Context] | [T.ConversationId, T.EntryId, Context]): ReturnType<T.Storage["entry"]> {
		if (args.length === 2) return this.#after(entryKey(args[0]), () => this.#source.entry(...args));
		return this.#after(conversationKey(args[0]), () =>
			this.#after(entryKey(args[1]), () => this.#source.entry(...args)),
		);
	}
	#entries<Value>(id: T.ConversationId, read: () => Promise<Value>): Promise<Value> {
		return this.#after(conversationKey(id), () => this.#after(appendKey(id), read));
	}
	#after<Value>(key: string, read: () => Promise<Value>): Promise<Value> {
		const wait = this.#touch(key);
		return wait === undefined ? read() : wait.then(read);
	}
}
