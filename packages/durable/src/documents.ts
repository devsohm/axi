import { copyJson, type JsonValue } from "@axi/chord";
import type { Op } from "@axi/chord/delta";
import { idFromNumber } from "./ids.ts";
import type {
	CheckpointInfo,
	CommonDocDefinition,
	ConversationDocFamilyToken,
	ConversationDocToken,
	ConversationId,
	DocDefinition,
	DocFamilyDefinition,
	DocFamilyToken,
	DocToken,
	DocumentAddress,
	DocumentCreate,
	DocumentId,
	DocumentRecord,
	DocumentSemantics,
	JsonObject,
	LatestConversationSemantics,
	RewindableConversationSemantics,
	RewindableConversationDocFamilyToken,
	RewindableConversationDocToken,
	SessionDocFamilyToken,
	SessionDocToken,
	StoredDocument,
	TaskDocFamilyToken,
	TaskDocToken,
	TaskId,
} from "./types.ts";

type Family<Value extends JsonObject, Seed extends JsonValue> = Omit<CommonDocDefinition<Value>, "initial"> & {
	readonly family: true;
	initial(seed: Seed): Value;
};
export function defineDoc<Value extends JsonObject>(
	definition: CommonDocDefinition<Value> & { readonly scope: "session" },
): SessionDocToken<Value>;
export function defineDoc<Value extends JsonObject>(
	definition: CommonDocDefinition<Value> & LatestConversationSemantics,
): ConversationDocToken<Value>;
export function defineDoc<Value extends JsonObject>(
	definition: CommonDocDefinition<Value> & RewindableConversationSemantics,
): RewindableConversationDocToken<Value>;
export function defineDoc<Value extends JsonObject>(
	definition: CommonDocDefinition<Value> & { readonly scope: "task" },
): TaskDocToken<Value>;
export function defineDoc<Value extends JsonObject>(
	definition: DocDefinition<Value>,
): DocToken<Value, DocDefinition<Value>> {
	validateVersion(definition);
	return { definition };
}
export function defineDocFamily<Value extends JsonObject, Seed extends JsonValue>(
	definition: Family<Value, Seed> & { readonly scope: "session" },
): SessionDocFamilyToken<Value, Seed>;
export function defineDocFamily<Value extends JsonObject, Seed extends JsonValue>(
	definition: Family<Value, Seed> & LatestConversationSemantics,
): ConversationDocFamilyToken<Value, Seed>;
export function defineDocFamily<Value extends JsonObject, Seed extends JsonValue>(
	definition: Family<Value, Seed> & RewindableConversationSemantics,
): RewindableConversationDocFamilyToken<Value, Seed>;
export function defineDocFamily<Value extends JsonObject, Seed extends JsonValue>(
	definition: Family<Value, Seed> & { readonly scope: "task" },
): TaskDocFamilyToken<Value, Seed>;
export function defineDocFamily<Value extends JsonObject, Seed extends JsonValue>(
	definition: DocFamilyDefinition<Value, Seed>,
): DocFamilyToken<Value, Seed, DocFamilyDefinition<Value, Seed>> {
	validateVersion(definition);
	return { definition };
}
export type AnyDocDefinition = DocumentSemantics & {
	readonly kind: string;
	readonly version: number;
	readonly family?: true;
	initial(seed?: JsonValue): JsonObject;
	migrate?(value: JsonObject, fromVersion: number): JsonObject;
	checkpointWhen(value: Readonly<JsonObject>, ops: readonly Op[], info: CheckpointInfo): boolean;
};
export type AnyDocToken = { readonly definition: AnyDocDefinition };
export type ResolvedAddress = { readonly address: DocumentAddress; readonly id: string; readonly nextArgument: number };
function validateVersion(definition: { readonly kind: string; readonly version: number }): void {
	if (!Number.isSafeInteger(definition.version) || definition.version <= 0)
		throw new TypeError(`Document ${definition.kind} version must be a positive integer`);
}
export function addressId(address: DocumentAddress): string {
	const scope = address.scope;
	return JSON.stringify([
		address.kind,
		scope.kind,
		scope.kind === "session" ? null : scope.kind === "task" ? scope.taskId : scope.conversationId,
		address.key ?? null,
	]);
}
export function resolveAddress(definition: AnyDocDefinition, args: readonly unknown[]): ResolvedAddress {
	let nextArgument = 0;
	let scope: DocumentAddress["scope"] = { kind: "session" };
	if (definition.scope !== "session") {
		const owner = args[nextArgument++];
		if (typeof owner !== "number" || !Number.isSafeInteger(owner))
			throw new TypeError(`Document ${definition.kind} requires a ${definition.scope} ID`);
		scope =
			definition.scope === "conversation"
				? { kind: "conversation", conversationId: idFromNumber<ConversationId>(owner) }
				: { kind: "task", taskId: idFromNumber<TaskId>(owner) };
	}
	const member = definition.family ? args[nextArgument++] : undefined;
	// Family keys are statically typed; persisted and overloaded argument boundaries share this erased representation.
	const address: DocumentAddress = {
		kind: definition.kind,
		scope,
		...(member === undefined ? {} : { key: member as string }),
	};
	return { address, id: addressId(address), nextArgument };
}
export function documentCreate(definition: AnyDocDefinition, address: DocumentAddress, id: DocumentId): DocumentCreate {
	const common = { id, kind: address.kind, ...(address.key === undefined ? {} : { key: address.key }) };
	if (address.scope.kind === "session") return { ...common, scope: address.scope };
	if (address.scope.kind === "task") return { ...common, scope: address.scope };
	if (definition.scope !== "conversation") throw new TypeError("Conversation document requires conversation semantics");
	return definition.history === "latest"
		? { ...common, scope: address.scope, history: "latest", fork: definition.fork }
		: { ...common, scope: address.scope, history: "rewindable", fork: definition.fork };
}
export function checkRecordScope(definition: AnyDocDefinition, record: DocumentCreate | DocumentRecord): void {
	if (
		record.scope.kind !== definition.scope ||
		(record.scope.kind === "conversation" && (record.history !== definition.history || record.fork !== definition.fork))
	)
		throw new TypeError(`Document ${record.id} (${record.kind}) does not match the supplied definition semantics`);
}
export function checkRecordVersion(
	definition: AnyDocDefinition,
	record: DocumentCreate | DocumentRecord,
	version: number,
): void {
	if (version > definition.version)
		throw new Error(`Document ${record.id} (${record.kind}) has newer version ${version} than ${definition.version}`);
	if (version < definition.version && !definition.migrate)
		throw new Error(`Document ${record.id} (${record.kind}) requires migration from version ${version}`);
}
export function materializeDocumentValue(
	definition: AnyDocDefinition,
	record: DocumentCreate | DocumentRecord,
	version: number,
	value: JsonObject,
): JsonObject {
	checkRecordScope(definition, record);
	checkRecordVersion(definition, record, version);
	if (version === definition.version) return value;
	const migrated = copyJson(definition.migrate!(value, version));
	return migrated as JsonObject;
}
export function materializeDocument(definition: AnyDocDefinition, stored: StoredDocument): JsonObject {
	return materializeDocumentValue(definition, stored.record, stored.version, stored.value);
}
