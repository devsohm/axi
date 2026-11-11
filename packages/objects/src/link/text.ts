import { CAUSE_KINDS, NO_RETIRED, type Codec, type Message } from "./message.ts";
import { parseJson, partText, textPart } from "./values.ts";

const utf8 = new TextEncoder();
const layouts: [Message["kind"], string, string[]][] = [
	["hello", "h", ["protocol", "incarnation", "calls"]],
	["release", "R", ["hold"]],
	["abort", "x", ["call"]],
	["error", "e", ["call", "error"]],
	["gone", "g", ["hold", "error"]],
	["revoke", "V", ["revocation"]],
	["loading", "l", ["hold"]],
	["ack", "a", []],
	["closed", "C", []],
	["ping", "p", []],
	["pong", "P", []],
];
const byKind = new Map(layouts.map(([kind, tag, fields]) => [kind, { tag, fields }]));
const byTag = new Map(layouts.map(([kind, tag, fields]) => [tag, { kind, fields }]));
const json = (value: unknown): string => JSON.stringify(value) ?? "null";
const tuple = (fields: readonly string[]): string => `[${fields.join(",")}]`;
const pairFailures = (failures: readonly { readonly member: number; readonly error: unknown }[]): string =>
	json(failures.map(({ member, error }) => [member, error]));

function ownMessage(message: Message): string {
	if (message.kind === "hello" && message.calls === undefined)
		return json(["h", message.protocol, message.incarnation]);
	if (message.kind === "ack" && message.events !== undefined) return json(["a", message.events]);
	const layout = byKind.get(message.kind);
	if (layout) return json([layout.tag, ...layout.fields.map((field) => Reflect.get(message, field))]);
	switch (message.kind) {
		case "event":
			return tuple([
				json("E"),
				tuple(
					message.events.map((event) =>
						tuple([json(event.hold), json(event.member), json(event.at), partText(event.value)]),
					),
				),
			]);
		case "hold": {
			const fields = [
				json("H"),
				json(message.hold),
				json(message.type),
				json(message.version),
				json(message.fingerprint),
				partText(message.params),
				json([message.address.kind, message.address.params]),
			];
			const optional = [message.principal, message.incarnation, message.chain, message.limit, message.trace];
			while (optional.length && optional.at(-1) === undefined) optional.pop();
			return tuple([...fields, ...optional.map(json)]);
		}
		case "call":
		case "result": {
			const fields =
				message.kind === "call"
					? [json("c"), json(message.call), json(message.hold), json(message.method)]
					: [json("r"), json(message.call)];
			const part = message.kind === "call" ? message.args : message.value;
			if (part !== undefined) {
				fields.push(partText(part));
				if (message.segments !== undefined) fields.push(json(message.segments.map((bytes) => bytes.byteLength)));
			}
			if (message.kind === "call" && (message.trace !== undefined || message.old !== undefined)) {
				while (fields.length < 6) fields.push("null");
				fields.push(json(message.trace));
				if (message.old !== undefined) fields.push(json(message.old));
			}
			return tuple(fields);
		}
		case "bound":
			return tuple([
				json("b"),
				tuple(
					message.holds.map((entry) =>
						tuple([
							json(entry.hold),
							json(entry.variant),
							tuple(entry.members.map(({ member, value }) => tuple([json(member), partText(value)]))),
							...(entry.failed.length ? [pairFailures(entry.failed)] : []),
						]),
					),
				),
			]);
		case "state":
			return tuple([
				json("s"),
				tuple(
					message.holds.map((entry) =>
						tuple([
							json(entry.hold),
							tuple(entry.members.map(({ member, ops }) => tuple([json(member), partText(ops)]))),
							...(entry.failed.length || entry.retired.length ? [pairFailures(entry.failed)] : []),
							...(entry.retired.length ? [json(entry.retired)] : []),
						]),
					),
				),
			]);
		case "failed":
			return json([
				"f",
				message.hold,
				message.cause.kind[0],
				message.cause.error,
				...(message.retryIn === undefined ? [] : [message.retryIn]),
			]);
		case "retry":
			return json(["T", message.hold, message.hops]);
		default:
			throw new Error(`text: an unknown kind ${message.kind}`);
	}
}

export function describeMessage(message: Message): string {
	const content = ownMessage(message);
	return "origin" in message && message.origin !== undefined ? `["@",${message.origin},${content}]` : content;
}

function list(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error("text: expected a list");
	return value;
}
function pairs(value: unknown): [unknown, unknown][] {
	return list(value).map((value) => {
		const pair = list(value);
		if (pair.length !== 2) throw new Error("text: expected a pair");
		return [pair[0], pair[1]];
	});
}
function failures(value: unknown): unknown[] {
	return value === undefined ? [] : pairs(value).map(([member, error]) => ({ member, error }));
}
function payload(fields: readonly unknown[], rest: Uint8Array, key: string): Record<string, unknown> {
	if (fields.length < 2) {
		if (rest.byteLength) throw new Error("text: byte segments without a payload that carries them");
		return fields.length ? { [key]: textPart(fields[0]) } : {};
	}
	let offset = 0;
	const segments = list(fields[1]).map((size) => {
		if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw new Error("text: a segment length");
		const segment = rest.subarray(offset, offset + size);
		offset += size;
		return segment;
	});
	if (offset !== rest.byteLength) throw new Error("text: the segments do not fill the message");
	return { [key]: textPart(fields[0]), segments };
}
function envelope(fields: unknown[], rest: Uint8Array): Record<string, unknown> {
	const [tag, ...args] = fields;
	const arity = (...sizes: number[]): void => {
		if (!sizes.includes(args.length)) throw new Error(`text: a "${String(tag)}" message with ${args.length} fields`);
	};
	if (tag !== "c" && tag !== "r" && rest.byteLength)
		throw new Error("text: byte segments without a payload that carries them");
	const fixed = typeof tag === "string" ? byTag.get(tag) : undefined;
	if (fixed) {
		if (fixed.kind === "hello") arity(2, 3);
		else if (fixed.kind === "ack") arity(0, 1);
		else arity(fixed.fields.length);
		const fields =
			fixed.kind === "hello"
				? fixed.fields.slice(0, args.length)
				: fixed.kind === "ack" && args.length
					? ["events"]
					: fixed.fields;
		return {
			kind: fixed.kind,
			...(fixed.kind === "closed" ? { origin: 0 } : {}),
			...Object.fromEntries(fields.map((field, index) => [field, args[index]])),
		};
	}
	switch (tag) {
		case "E":
			arity(1);
			return {
				kind: "event",
				events: list(args[0]).map((item) => {
					const entry = list(item);
					if (entry.length !== 4) throw new Error(`text: an event entry with ${entry.length} fields`);
					return { hold: entry[0], member: entry[1], at: entry[2], value: textPart(entry[3]) };
				}),
			};
		case "H": {
			arity(6, 7, 8, 9, 10, 11);
			const address = list(args[5]);
			if (address.length !== 2) throw new Error("text: an address is a pair");
			const optional = Object.fromEntries(
				["principal", "incarnation", "chain", "limit", "trace"].flatMap((name, index) =>
					args[index + 6] == null ? [] : [[name, args[index + 6]]],
				),
			);
			return {
				kind: "hold",
				hold: args[0],
				type: args[1],
				version: args[2],
				fingerprint: args[3],
				params: textPart(args[4]),
				address: { kind: address[0], params: address[1] },
				...optional,
			};
		}
		case "c": {
			arity(3, 4, 5, 6, 7);
			let parameters = args.slice(3, 5);
			if (args.length >= 6) {
				if (args[3] === null) parameters = [];
				else if (args[4] === null) parameters = [args[3]];
			}
			return {
				kind: "call",
				call: args[0],
				hold: args[1],
				method: args[2],
				...payload(parameters, rest, "args"),
				...(args[5] == null ? {} : { trace: args[5] }),
				...(args[6] === undefined ? {} : { old: args[6] }),
			};
		}
		case "r":
			arity(1, 2, 3);
			return {
				kind: "result",
				call: args[0],
				...payload(args.slice(1), rest, "value"),
			};
		case "b":
		case "s": {
			arity(1);
			return {
				kind: tag === "b" ? "bound" : "state",
				holds: list(args[0]).map((raw) => {
					const entry = list(raw),
						bound = tag === "b";
					if (entry.length < (bound ? 3 : 2) || entry.length > 4)
						throw new Error(`text: a ${bound ? "bound" : "state"} entry with ${entry.length} fields`);
					const members = pairs(entry[bound ? 2 : 1]).map(([member, value]) => ({
						member,
						[bound ? "value" : "ops"]: textPart(value),
					}));
					return {
						hold: entry[0],
						...(bound ? { variant: entry[1] } : {}),
						members,
						failed: failures(entry[bound ? 3 : 2]),
						...(bound
							? {}
							: {
									retired: entry[3] === undefined ? NO_RETIRED : list(entry[3]),
								}),
					};
				}),
			};
		}
		case "f": {
			arity(3, 4);
			const kind = CAUSE_KINDS.find((kind) => kind[0] === args[1]);
			if (!kind) throw new Error("text: an unknown failure kind");
			return {
				kind: "failed",
				hold: args[0],
				cause: { kind, error: args[2] },
				...(args.length === 4 ? { retryIn: args[3] } : {}),
			};
		}
		case "T":
			arity(2);
			return { kind: "retry", hold: args[0], hops: args[1] };
		default:
			throw new Error("text: an unknown kind");
	}
}

export const textCodec: Codec = {
	name: "text",
	encode(message) {
		const header = utf8.encode(describeMessage(message));
		const segments = message.kind === "call" || message.kind === "result" ? message.segments : undefined;
		if (segments === undefined) return header;
		const bytes = new Uint8Array(
			header.byteLength + 1 + segments.reduce((sum, segment) => sum + segment.byteLength, 0),
		);
		bytes.set(header);
		bytes[header.byteLength] = 10;
		let offset = header.byteLength + 1;
		for (const segment of segments) {
			bytes.set(segment, offset);
			offset += segment.byteLength;
		}
		return bytes;
	},
	decode(bytes) {
		const split = bytes.indexOf(10),
			raw = parseJson(split < 0 ? bytes : bytes.subarray(0, split));
		if (!Array.isArray(raw)) throw new Error("text: a message is a tuple");
		const rest = bytes.subarray(split < 0 ? bytes.byteLength : split + 1);
		let fields = raw,
			origin: unknown;
		if (raw[0] === "@") {
			fields = raw.length === 3 ? list(raw[2]) : [];
			if (!fields.length || fields[0] === "@") throw new Error("text: an origin wraps one message");
			origin = raw[1];
		}
		const decoded = envelope(fields, rest);
		if (raw[0] === "@") decoded.origin = origin;
		// Framing is checked here; the receiving channel validates the envelope.
		return decoded as Message;
	},
};
