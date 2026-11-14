import { objectsMetrics } from "../telemetry.ts";
import Type from "typebox";
import type { Context } from "../context/index.ts";
import { arr, int, lit, obj, oneOf, opt, str, union, unknown, type Static, type TSchema } from "../contracts/index.ts";
import { validatorFor } from "../data/internal.ts";
import type { Part } from "./part.ts";

const id = int({ min: 0 }),
	origin = int({ min: 1 }),
	index = int({ min: 0 });
const error = union([
	obj({ kind: lit("objects"), error: unknown() }),
	obj({
		kind: lit("plugin"),
		code: str(),
		message: str(),
		details: opt(unknown()),
	}),
]);
const failures = arr(obj({ member: index, error }));
const part = Type.Unsafe<Part>({});
const segments = opt(Type.Unsafe<readonly Uint8Array[]>({}));
export const NAME_LENGTH = 256;
export const CARRIER = { keys: 8, length: 256 } as const;
const trace = opt(
	Type.Record(Type.String(), Type.String({ maxLength: CARRIER.length, pattern: "^[\\x20-\\x7e]*$" }), {
		propertyNames: { maxLength: CARRIER.length, pattern: "^[\\x21-\\x7e]+$" },
		maxProperties: CARRIER.keys,
	}),
);
const address = obj({ kind: str({ max: NAME_LENGTH }), params: unknown() });
const principal = Type.Object({ kind: str() });
const incarnation = str({
	pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
export const CHAIN = 32;
export const RETRY_HOPS = 16;
export const CAUSE_KINDS: ["transient", "broken", "waiting"] = ["transient", "broken", "waiting"];
const hold = { origin: opt(origin), hold: id },
	call = { origin: opt(origin), call: id };
function message<const K extends string, const F extends Readonly<Record<string, TSchema>>>(kind: K, fields: F) {
	return obj({ kind: lit(kind), ...fields });
}
const schema = union([
	message("hello", {
		protocol: int({ min: 0 }),
		incarnation,
		calls: opt(int({ min: 1 })),
	}),
	message("hold", {
		...hold,
		type: str({ max: NAME_LENGTH }),
		version: int({ min: 1 }),
		fingerprint: str({ pattern: "^[0-9a-f]{16}$" }),
		params: part,
		address,
		principal: opt(principal),
		incarnation: opt(incarnation),
		chain: opt(Type.Array(incarnation, { maxItems: CHAIN })),
		limit: opt(int({ min: 0 })),
		trace,
	}),
	message("release", hold),
	message("call", {
		...call,
		hold: id,
		method: index,
		args: opt(part),
		segments,
		trace,
		old: opt(lit(true)),
	}),
	message("abort", call),
	message("retry", {
		...hold,
		hops: int({ min: 1, max: RETRY_HOPS }),
	}),
	message("bound", {
		origin: opt(origin),
		holds: arr(
			obj({
				hold: id,
				variant: index,
				members: arr(obj({ member: index, value: part })),
				failed: failures,
			}),
		),
	}),
	message("state", {
		origin: opt(origin),
		holds: arr(
			obj({
				hold: id,
				members: arr(obj({ member: index, ops: part })),
				failed: failures,
				retired: arr(index),
			}),
		),
	}),
	message("ack", { origin: opt(origin), events: opt(int({ min: 1 })) }),
	message("closed", { origin }),
	message("revoke", { revocation: unknown() }),
	message("ping", {}),
	message("pong", {}),
	message("failed", {
		...hold,
		cause: obj({ kind: oneOf(...CAUSE_KINDS), error }),
		retryIn: opt(int({ min: 0 })),
	}),
	message("loading", hold),
	message("result", { ...call, value: opt(part), segments }),
	message("error", { ...call, error }),
	message("gone", { ...hold, error }),
	message("event", {
		origin: opt(origin),
		events: arr(obj({ hold: id, member: index, at: int({ min: 0 }), value: part })),
	}),
]);
type WireMessage = Static<typeof schema>;
type WireState = Extract<WireMessage, { readonly kind: "state" }>;
export type StateEntry = Omit<WireState["holds"][number], "retired"> & {
	readonly retired: readonly number[];
};
export type Message =
	| Exclude<WireMessage, WireState>
	| (Omit<WireState, "holds"> & { readonly holds: readonly StateEntry[] });
export type WireError = Static<typeof error>;
export type WireAddress = Static<typeof address>;
export type FailedMember = Static<typeof failures>[number];
export type BoundEntry = Extract<Message, { readonly kind: "bound" }>["holds"][number];
export type WireEvent = Extract<Message, { readonly kind: "event" }>["events"][number];
export type OriginMessage = Exclude<Message, { readonly kind: "hello" | "revoke" | "ping" | "pong" }>;
export type ProviderMessage = Extract<
	Message,
	{ readonly kind: "hold" | "release" | "call" | "abort" | "retry" | "ack" }
>;
export type ConsumerMessage = Extract<
	Message,
	{
		readonly kind: "bound" | "state" | "failed" | "loading" | "result" | "error" | "gone" | "event";
	}
>;
export const NO_RETIRED: readonly number[] = [];
export interface Codec {
	readonly name: string;
	encode(message: Message): Uint8Array;
	decode(bytes: Uint8Array): Message;
}
const owner = { schema };
export function checkMessage(message: unknown, context: Context): Message {
	objectsMetrics(context.telemetry.metrics).counter("objects.link.checks").add(1);
	if (!validatorFor(owner, context).check(message)) throw new Error("message: fails the message schema");
	return message as Message;
}
