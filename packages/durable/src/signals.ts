import { isJsonValue, type JsonValue } from "@axi/objects/json";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { TaskRecord, TaskState, WakeReason } from "./types.ts";
import type { SettledSubmissionRecord } from "./harness/types.ts";

export type SignalKey<T> = { readonly signal: string; readonly key: string; readonly "~value"?: T };
export interface SignalToken<T> {
	readonly name: string;
	readonly version: number;
	key(key: string): SignalKey<T>;
}
export type SignalDefinition<S extends TSchema> = {
	readonly name: string;
	readonly version: number;
	readonly schema: S;
	readonly migrate?: (value: JsonValue, fromVersion: number) => Static<S>;
};
export type SignalState<T> = { readonly value: T } | { readonly expired: true };
export type SignalResult = "delivered" | "duplicate" | "invalid" | "closed" | "not_found";

type SignalMemo = { version: number; value: JsonValue; consumed?: true } | { expired: true };
type Memos = Readonly<Record<string, JsonValue>>;
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type Sleep = Extract<TaskState<JsonValue, JsonValue>, { status: "sleeping" }>;
const tokens = new WeakMap<
	object,
	{ check(value: unknown): boolean; migrate?: (value: JsonValue, version: number) => unknown }
>();

const schemaChildren = [
	"items",
	"prefixItems",
	"additionalItems",
	"unevaluatedItems",
	"contains",
	"anyOf",
	"oneOf",
	"allOf",
	"not",
	"if",
	"then",
	"else",
	"additionalProperties",
	"unevaluatedProperties",
	"propertyNames",
];
const schemaMaps = ["properties", "patternProperties", "dependentSchemas", "dependencies", "$defs", "definitions"];
function nonJson(schema: unknown): string | undefined {
	if (schema === null || typeof schema !== "object") return;
	const node = schema as { [key: string]: unknown };
	for (const type of Array.isArray(node.type) ? node.type : [node.type])
		if (type === "bytes" || type === "bigint" || type === "undefined") return type;
	const children = schemaChildren.flatMap((key) => (Array.isArray(node[key]) ? node[key] : [node[key]]));
	for (const key of schemaMaps) {
		const map = node[key];
		if (map !== null && typeof map === "object") children.push(...Object.values(map));
	}
	for (const child of children) {
		const type = nonJson(child);
		if (type !== undefined) return type;
	}
}

export function defineSignal<S extends TSchema>({
	name,
	version,
	schema,
	migrate,
}: SignalDefinition<S>): SignalToken<Static<S>> {
	if (!name || name.includes("/"))
		throw new TypeError(`Signal name ${JSON.stringify(name)} must be non-empty, without "/"`);
	if (!Number.isInteger(version) || version < 1)
		throw new TypeError(`Signal ${name} version must be a positive integer`);
	const type = nonJson(schema);
	if (type !== undefined) throw new TypeError(`Signal ${name} schema admits non-JSON values (${type})`);
	const token: SignalToken<Static<S>> = {
		name,
		version,
		key(key) {
			if (!key) throw new TypeError(`Signal ${name} key must be non-empty`);
			return { signal: name, key };
		},
	};
	tokens.set(token, { check: (value) => Value.Check(schema, value), migrate });
	return token;
}

const settled = (
	type: "input" | "write" | "continue",
	status: "done" | "unanswered",
	fields: { [name: string]: TSchema },
) =>
	Type.Object({
		id: Type.Integer(),
		conversationId: Type.Integer(),
		requestId: Type.Optional(Type.String()),
		notify: Type.Optional(Type.Object({ taskId: Type.Integer(), key: Type.String() })),
		type: Type.Literal(type),
		status: Type.Literal(status),
		...fields,
	});
export const SubmissionSettled = defineSignal({
	name: "axi.submission-settled",
	version: 1,
	schema: Type.Unsafe<SettledSubmissionRecord>(
		Type.Union([
			settled("input", "done", { entry: Type.Integer(), answer: Type.Integer() }),
			settled("write", "done", { entry: Type.Integer() }),
			settled("continue", "done", { answer: Type.Integer() }),
			settled("input", "unanswered", { entry: Type.Optional(Type.Integer()), reason: Type.String() }),
			settled("write", "unanswered", { reason: Type.String() }),
			settled("continue", "unanswered", { reason: Type.String() }),
		]),
	),
});

function definition(token: SignalToken<unknown>) {
	const found = tokens.get(token);
	if (!found) throw new TypeError(`Signal ${token.name} was not built by defineSignal()`);
	return found;
}
const nameOf = (signal: string, key: string) => `axi.signal.${signal}/${key}`;
function memo(memos: Memos | undefined, name: string): SignalMemo | undefined {
	return memos && Object.hasOwn(memos, name) ? (memos[name] as SignalMemo) : undefined;
}

export function deliverSignal<T>(
	record: StoredTask | undefined,
	token: SignalToken<T>,
	key: string,
	value: T,
	now: number,
): { result: SignalResult; record?: StoredTask } {
	if (!record) return { result: "not_found" };
	if (record.abortRequested || record.state.status === "terminal" || record.state.status === "completing")
		return { result: "closed" };
	if (!key || !isJsonValue(value) || !definition(token).check(value)) return { result: "invalid" };
	const name = nameOf(token.name, key),
		stored = memo(record.memos, name);
	if (stored) return { result: "expired" in stored ? "closed" : "duplicate" };
	const expired =
		record.state.status === "sleeping" &&
		record.state.until !== undefined &&
		record.state.until <= now &&
		record.state.signals?.some((item) => item.signal === token.name && item.key === key);
	return {
		result: expired ? "closed" : "delivered",
		record: {
			...record,
			memos: { ...record.memos, [name]: expired ? { expired: true } : { version: token.version, value } },
		} as StoredTask,
	};
}

export function readSignal<T>(
	memos: Memos | undefined,
	token: SignalToken<T>,
	key: string,
): SignalState<T> | undefined {
	const stored = memo(memos, nameOf(token.name, key));
	if (!stored) return;
	if ("expired" in stored) return { expired: true };
	if (stored.version === token.version) return { value: stored.value as T };
	if (stored.version > token.version)
		throw new Error(`Signal ${token.name} value has version ${stored.version}, newer than ${token.version}`);
	const { migrate, check } = definition(token);
	if (!migrate) throw new Error(`Signal ${token.name} has no migration from version ${stored.version}`);
	const value = migrate(stored.value, stored.version);
	if (!isJsonValue(value) || !check(value))
		throw new Error(`Signal ${token.name} migration from version ${stored.version} returned an invalid value`);
	return { value: value as T };
}

function ready(state: Sleep, memos: Memos | undefined) {
	return state.signals?.find(({ signal, key }) => {
		const stored = memo(memos, nameOf(signal, key));
		return stored !== undefined && !("expired" in stored) && !stored.consumed;
	});
}
export function checkSleep(state: Sleep, memos: Memos | undefined, task: number): void {
	if (state.until === undefined && !state.signals?.length)
		throw new Error(`Task ${task} cannot sleep without until or signals`);
	for (const { signal, key } of state.signals ?? []) {
		const stored = memo(memos, nameOf(signal, key));
		if (stored && ("expired" in stored || stored.consumed))
			throw new Error(
				`Task ${task} cannot sleep on signal ${signal} key ${key}: ${"expired" in stored ? "it expired" : "it already woke a wait"}`,
			);
	}
}
export function sleepDue(state: Sleep, memos: Memos | undefined, now: number): boolean {
	return ready(state, memos) !== undefined || (state.until !== undefined && state.until <= now);
}
export function sleepWake(
	state: Sleep,
	memos: Memos | undefined,
	now: number,
): { wake: WakeReason; memos: Memos } | undefined {
	const key = ready(state, memos);
	if (key) {
		const name = nameOf(key.signal, key.key);
		return { wake: { reason: "signal", ...key }, memos: { [name]: { ...memo(memos, name), consumed: true } } };
	}
	if (state.until === undefined || state.until > now) return;
	const expired: { [key: string]: JsonValue } = {};
	for (const { signal, key } of state.signals ?? []) {
		const name = nameOf(signal, key);
		if (!memo(memos, name)) expired[name] = { expired: true };
	}
	return { wake: { reason: state.signals?.length ? "expired" : "time" }, memos: expired };
}
