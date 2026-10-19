import { type Static, type TProperties, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { DescriptionSchema } from "./contract.ts";
import { CHORD_ERROR_CODES, ChordError } from "./errors.ts";

export const PROTOCOL_VERSION = 4;
const id = Type.Integer({ minimum: 1 });
const name = Type.String({ minLength: 1 });
const list = <S extends TSchema>(schema: S) => Type.Immutable(Type.Array(schema));
const optional = Type.Optional;
const root = Type.Object({ rootId: name, codeVersion: Type.Integer({ minimum: 1 }) });
const error = Type.Object({
	code: Type.Enum(CHORD_ERROR_CODES),
	message: Type.String(),
	reason: optional(Type.String()),
});
const reloadOptions = Type.Object({
	remove: optional(list(Type.String())),
	gateDeadline: optional(Type.Number()),
	retireDeadline: optional(Type.Number()),
});
const report = Type.Object({
	codeVersion: Type.Integer(),
	previous: Type.Integer(),
	changed: list(Type.String()),
	removed: list(Type.String()),
	prepared: list(Type.String()),
	gated: list(Type.String()),
});
export type RootRef = Static<typeof root>;
export type WireError = Static<typeof error>;
export type WireReloadOptions = Static<typeof reloadOptions>;
export type WireReloadReport = Static<typeof report>;

function frame<N extends string, P extends TProperties>(t: N, fields: P) {
	return Type.Object({ t: Type.Literal(t), ...fields });
}
const schema = Type.Union([
	frame("hello", {
		protocol: optional(id),
		name,
		kind: Type.Enum(["host", "client"]),
		codeVersion: Type.Integer({ minimum: 0 }),
		acks: optional(Type.Boolean()),
	}),
	frame("ack", { n: id }),
	frame("hold", {
		id,
		at: name,
		token: DescriptionSchema,
		input: Type.Unknown(),
		principal: optional(Type.Unknown()),
		origin: optional(name),
		state: optional(Type.Literal(false)),
		again: optional(Type.Literal(true)),
	}),
	frame("release", { id }),
	frame("shape", {
		id,
		variant: optional(Type.String()),
		members: list(Type.String()),
		contract: Type.String(),
		state: list(name),
	}),
	frame("gone", { id, error }),
	frame("call", { id, hold: id, member: name, args: optional(Type.Unknown()), root: optional(root) }),
	frame("result", { id, value: optional(Type.Unknown()), error: optional(error) }),
	frame("cancel", { id }),
	frame("sub", { hold: id }),
	frame("unsub", { hold: id }),
	frame("resync", { hold: id, m: name }),
	frame("state", {
		hold: id,
		m: name,
		as: Type.Enum(["snap", "reset", "ops", "error"]),
		value: optional(Type.Unknown()),
		ops: optional(list(list(Type.Unknown()))),
		error: optional(error),
	}),
	frame("ping", { n: Type.Integer() }),
	frame("pong", { n: Type.Integer() }),
	frame("bye", { reason: optional(Type.String()) }),
	frame("root_end", { rootId: name }),
	frame("invalidate", { pattern: Type.Record(Type.String(), Type.Unknown()) }),
	frame("prepare", { reload: id, codeVersion: id, plugins: list(Type.String()), options: reloadOptions }),
	frame("vote", { reload: id, error: optional(error), report: optional(report) }),
	frame("commit", { reload: id }),
	frame("retire", { codeVersion: id }),
	frame("abort", { reload: id }),
]);
export type Frame = Static<typeof schema>;
export const isFrame = (value: unknown): value is Frame => Value.Check(schema, value);
export function toWireError(cause: unknown): WireError {
	if (!(cause instanceof ChordError))
		return { code: "unavailable", message: cause instanceof Error ? cause.message : String(cause) };
	return cause.reason === undefined
		? { code: cause.code, message: cause.message }
		: { code: cause.code, message: cause.message, reason: cause.reason };
}
export function fromWireError(value: WireError): ChordError {
	return new ChordError(value.code, value.message.replace(/^[a-z_]+(\/[a-z_]+)?: /, ""), { reason: value.reason });
}
