import type { JsonValue } from "@axi/chord";
import type { Entry, EntryRecord, TypedEntry } from "./types.ts";
import type { CompactionReason, ToolDiagnostic } from "./harness/types.ts";

export function defineEntry<Value extends JsonValue = never>(kind: string): Entry<Value> {
	if (typeof kind !== "string" || !kind.length) throw new TypeError("Entry kind must be a non-empty string");
	return {
		kind,
		is(entry: EntryRecord | undefined): entry is TypedEntry<Value> {
			return entry?.kind === kind;
		},
	};
}

export const UserEntry = defineEntry("axi.user");
export const AssistantEntry = defineEntry("axi.assistant");
export const SystemEntry = defineEntry("axi.system");
export const ToolResultEntry = defineEntry<{ diagnostics: ToolDiagnostic[] }>("axi.tool-result");
export const ResetEntry = defineEntry("axi.reset");
export const CompactionEntry = defineEntry<{ reason: CompactionReason }>("axi.compaction");
