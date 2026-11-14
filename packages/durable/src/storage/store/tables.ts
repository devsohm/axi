import type { JsonValue } from "@axi/objects/json";
import { defineTable, int, json, str, unknown } from "@axi/objects";
import type { ConversationRecord, EntryRecord, SubmissionRecord, TaskRecord } from "../../types.ts";

const record = () => json(unknown(), { version: 1 });
export const RecordIds = defineTable("record_ids", {
	version: 1,
	columns: { id: int(), record_type: str() },
	key: ["id"],
});
export const Conversations = defineTable("conversations", {
	version: 1,
	columns: {
		id: int(),
		owner_conversation_id: int(),
		owner_task_id: int(),
		record: record(),
	},
	key: ["id"],
	indexes: {
		by_owner_conversation: ["owner_conversation_id"],
		by_owner_task: ["owner_task_id"],
	},
});
export const Entries = defineTable("entries", {
	version: 1,
	columns: {
		id: int(),
		conversation_id: int(),
		commit_seq: int(),
		record: record(),
	},
	key: ["id"],
	indexes: { by_conversation: ["conversation_id"] },
});
export const EntryHeads = defineTable("entry_heads", {
	version: 1,
	columns: { id: int(), conversation_id: int() },
	key: ["id"],
	indexes: { by_conversation: ["conversation_id"] },
});
export const Tasks = defineTable("tasks", {
	version: 1,
	columns: {
		id: int(),
		conversation_id: int(),
		kind: str(),
		status: str(),
		abort_requested: int(),
		background: int(),
		record: record(),
	},
	key: ["id"],
	indexes: {
		by_status: ["status"],
		by_conversation: ["conversation_id"],
		by_kind: ["kind"],
		by_abort_requested: ["abort_requested"],
		by_background: ["background"],
	},
});
export const Submissions = defineTable("submissions", {
	version: 1,
	columns: {
		id: int(),
		conversation_id: int(),
		request_id: str(),
		status: str(),
		record: record(),
	},
	key: ["id"],
	indexes: {
		by_request: ["conversation_id", "request_id"],
		by_conversation: ["conversation_id"],
		by_status: ["status"],
	},
});
export function encodeIndexed(value: string): string {
	return JSON.stringify(value);
}
export function conversationRow(value: ConversationRecord): object {
	return {
		id: value.id,
		owner_conversation_id: value.owner?.conversationId ?? 0,
		owner_task_id: value.owner?.taskId ?? 0,
		record: value,
	};
}
export function entryRow(value: EntryRecord): object {
	return {
		id: value.id,
		conversation_id: value.conversationId,
		commit_seq: 0,
		record: value,
	};
}
export function taskRow(value: TaskRecord<JsonValue, JsonValue, JsonValue>): object {
	return {
		id: value.id,
		conversation_id: value.conversationId,
		kind: encodeIndexed(value.kind),
		status: value.state.status,
		abort_requested: Number(Boolean(value.abortRequested)),
		background: Number(Boolean(value.background)),
		record: value,
	};
}
export function submissionRow(value: SubmissionRecord): object {
	return {
		id: value.id,
		conversation_id: value.conversationId,
		request_id: value.requestId === undefined ? "" : encodeIndexed(value.requestId),
		status: value.status,
		record: value,
	};
}
