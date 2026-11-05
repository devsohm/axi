import type * as T from "../../types.ts";

export type Cell = string | number | null;
export type Table = "conversation" | "entry" | "task" | "submission" | "document";
export type Action = {
	create?: T.DocumentCreate;
	copy?: T.DocumentCopySource;
	content?: T.DocumentContent;
	retire: boolean;
};
export const encode = JSON.stringify;
export function decode<Value>(text: string): Value {
	return JSON.parse(text) as Value;
}
export function scopeValues(scope: T.DocumentRecord["scope"]): readonly [string, number] {
	return [
		scope.kind,
		scope.kind === "session" ? 0 : scope.kind === "conversation" ? scope.conversationId : scope.taskId,
	];
}
export function addressValues(address: T.DocumentAddress): Cell[] {
	return [
		encode(address.kind),
		...scopeValues(address.scope),
		address.key === undefined ? 0 : 1,
		encode(address.key ?? ""),
	];
}
export const currentOnly = (record: T.DocumentRecord): boolean =>
	record.scope.kind !== "conversation" || record.history === "latest";
export function claim(write: T.StorageWrite): { id: number; table: Table } | undefined {
	if (write.type === "document.change" || write.type === "document.retire") return undefined;
	return "record" in write ? { id: write.record.id, table: "document" } : { id: write.value.id, table: write.type };
}
