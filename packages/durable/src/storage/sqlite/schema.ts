import { validateSqliteSchemaPrefix } from "@axi/chord/sqlite";
const tableNames = {
	durableSchema: "durable_schema",
	durableMetadata: "durable_metadata",
	recordIds: "record_ids",
	conversations: "conversations",
	entries: "entries",
	tasks: "tasks",
	submissions: "submissions",
	documents: "documents",
	documentRevisions: "document_revisions",
} as const;
const indexNames = {
	conversationsByOwnerConversation: "conversations_by_owner_conversation",
	conversationsByOwnerTask: "conversations_by_owner_task",
	entriesByConversation: "entries_by_conversation",
	entryHeadsByConversation: "entry_heads_by_conversation",
	tasksByStatus: "tasks_by_status",
	tasksByConversation: "tasks_by_conversation",
	tasksByKind: "tasks_by_kind",
	tasksByAbortRequested: "tasks_by_abort_requested",
	tasksByBackground: "tasks_by_background",
	submissionsByRequest: "submissions_by_request",
	submissionsByConversation: "submissions_by_conversation",
	submissionsByStatus: "submissions_by_status",
	documentsByAddress: "documents_by_address",
	documentsByScope: "documents_by_scope",
	documentsByScopeKind: "documents_by_scope_kind",
	documentRevisionsByKind: "document_revisions_by_kind",
} as const;
type Names<Dictionary> = { readonly [Key in keyof Dictionary]: string };
export type SqliteSchema = { readonly tables: Names<typeof tableNames>; readonly indexes: Names<typeof indexNames> };
function prefixed<Dictionary extends Record<string, string>>(
	dictionary: Dictionary,
	prefix: string,
): Names<Dictionary> {
	return Object.fromEntries(
		Object.entries(dictionary).map(([key, value]) => [key, prefix + value]),
	) as Names<Dictionary>;
}
export function createSqliteSchema(prefix?: string): SqliteSchema {
	if (prefix !== undefined) validateSqliteSchemaPrefix(prefix);
	return { tables: prefixed(tableNames, prefix ?? ""), indexes: prefixed(indexNames, prefix ?? "") };
}
export const DEFAULT_SQLITE_SCHEMA = createSqliteSchema();
