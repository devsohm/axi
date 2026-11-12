import { CAUSE_KINDS, NO_RETIRED, type Codec, type FailedMember, type Message } from "./message.ts";
import { DeflatedPart, type Part } from "./part.ts";
import { parseJson, readUtf8 } from "./values.ts";

const utf8 = new TextEncoder();
const kinds = [
	"hello",
	"hold",
	"release",
	"call",
	"abort",
	"bound",
	"state",
	"failed",
	"result",
	"error",
	"gone",
	"retry",
	"loading",
	"ack",
	"closed",
	"ping",
	"pong",
	"revoke",
	"event",
] as const;
type Scalar = "integer" | "text" | "uuid" | "hex" | "json";
const layouts = new Map<Message["kind"], readonly [string, Scalar][]>([
	[
		"hello",
		[
			["protocol", "integer"],
			["incarnation", "uuid"],
			["calls", "integer"],
		],
	],
	["release", [["hold", "integer"]]],
	["loading", [["hold", "integer"]]],
	["abort", [["call", "integer"]]],
	[
		"error",
		[
			["call", "integer"],
			["error", "json"],
		],
	],
	[
		"gone",
		[
			["hold", "integer"],
			["error", "json"],
		],
	],
	["revoke", [["revocation", "json"]]],
	["ack", []],
	["closed", []],
	["ping", []],
	["pong", []],
]);

class PacketWriter {
	#bytes = new Uint8Array(256);
	#used = 0;
	#room(size: number): void {
		if (size <= this.#bytes.length - this.#used) return;
		const next = new Uint8Array(Math.max(this.#bytes.length * 2, this.#used + size + 4096));
		next.set(this.#bytes.subarray(0, this.#used));
		this.#bytes = next;
	}
	byte(value: number): void {
		this.#room(1);
		this.#bytes[this.#used++] = value;
	}
	integer(value: number): void {
		while (value >= 128) {
			this.byte((value % 128) | 128);
			value = Math.floor(value / 128);
		}
		this.byte(value);
	}
	raw(bytes: Uint8Array): void {
		this.#room(bytes.length);
		this.#bytes.set(bytes, this.#used);
		this.#used += bytes.length;
	}
	text(value: string, scale = 1): void {
		if (value.length <= 42 / scale) {
			this.#room(1 + value.length * 3);
			const written = utf8.encodeInto(value, this.#bytes.subarray(this.#used + 1)).written;
			this.#bytes[this.#used] = written * scale;
			this.#used += 1 + written;
			return;
		}
		if (value.length < 4096) {
			const bytes = utf8.encode(value);
			this.integer(bytes.length * scale);
			this.raw(bytes);
			return;
		}
		const header = this.#used;
		this.#room(value.length + 5);
		this.#used += 5;
		let cursor = 0;
		while (cursor < value.length) {
			const copied = utf8.encodeInto(cursor ? value.slice(cursor) : value, this.#bytes.subarray(this.#used));
			this.#used += copied.written;
			cursor += copied.read;
			if (cursor < value.length) this.#room(Math.max(4, (value.length - cursor) * 2));
		}
		let size = (this.#used - header - 5) * scale;
		for (let index = 0; index < 5; index++) {
			this.#bytes[header + index] = (size % 128) | (index < 4 ? 128 : 0);
			size = Math.floor(size / 128);
		}
	}
	json(value: unknown): void {
		this.text(JSON.stringify(value) ?? "null");
	}
	part(value: Part): void {
		if (typeof value === "string") {
			this.text(value, 2);
			return;
		}
		const compressed = value instanceof DeflatedPart,
			bytes = compressed ? value.bytes : value;
		this.integer(bytes.length * 2 + Number(compressed));
		this.raw(bytes);
	}
	list<T>(values: readonly T[], write: (value: T) => void): void {
		this.integer(values.length);
		for (const value of values) write(value);
	}
	failures(values: readonly FailedMember[]): void {
		for (const value of values) {
			this.integer(value.member);
			this.json(value.error);
		}
	}
	payload(value: Part | undefined, segments: readonly Uint8Array[] | undefined): void {
		this.integer(value === undefined ? 0 : segments === undefined ? 1 : 3);
		if (value === undefined) return;
		this.part(value);
		if (segments === undefined) return;
		this.list(segments, (segment) => this.integer(segment.length));
		for (const segment of segments) this.raw(segment);
	}
	field(type: Scalar, value: unknown): void {
		if (type === "json") {
			this.json(value);
			return;
		}
		if (type === "integer" && typeof value === "number") {
			this.integer(value);
			return;
		}
		if (typeof value !== "string") throw new Error(`binary: not a ${type}`);
		if (type === "text") {
			this.text(value);
			return;
		}
		const size = type === "hex" ? 8 : 16,
			hex = type === "uuid" ? value.replaceAll("-", "") : value;
		if (hex.length !== size * 2 || !/^[0-9a-f]+$/.test(hex)) throw new Error(`binary: not ${size} bytes of hex`);
		for (let index = 0; index < size; index++) this.byte(Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
	}
	finish(): Uint8Array {
		const message = this.#bytes.subarray(0, this.#used),
			spare = this.#bytes.length - this.#used;
		return spare >= 64 && spare * 8 > this.#used ? message.slice() : message;
	}
}

class PacketReader {
	readonly #bytes: Uint8Array;
	#at = 0;
	constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
	}
	byte(): number {
		const value = this.#bytes[this.#at++];
		if (value === undefined) throw new Error("binary: the message ends early");
		return value;
	}
	integer(): number {
		let value = 0,
			factor = 1;
		for (let count = 0; count < 8; count++) {
			const byte = this.byte();
			value += (byte & 127) * factor;
			if (value > Number.MAX_SAFE_INTEGER) break;
			if (byte < 128) return value;
			factor *= 128;
		}
		throw new Error("binary: a varint does not fit");
	}
	raw(length: number): Uint8Array {
		if (length > this.#bytes.length - this.#at) throw new Error("binary: the message ends early");
		const start = this.#at;
		this.#at += length;
		return this.#bytes.subarray(start, this.#at);
	}
	field(type: Scalar): unknown {
		if (type === "integer") return this.integer();
		if (type === "text") return readUtf8(this.raw(this.integer()));
		if (type === "json") return parseJson(this.raw(this.integer()));
		const hex = Array.from(this.raw(type === "hex" ? 8 : 16), (value) => value.toString(16).padStart(2, "0")).join("");
		return type === "hex"
			? hex
			: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	}
	part(): Uint8Array | DeflatedPart {
		const size = this.integer(),
			bytes = this.raw(Math.floor(size / 2));
		return size % 2 ? new DeflatedPart(bytes) : bytes;
	}
	list<T>(read: () => T, count = this.integer()): T[] {
		if (count > this.#bytes.length - this.#at) throw new Error("binary: a count does not fit");
		return Array.from({ length: count }, read);
	}
	failures(count = this.integer()): unknown[] {
		return this.list(() => ({ member: this.integer(), error: this.field("json") }), count);
	}
	payload(key: string): Record<string, unknown> {
		const flags = this.integer();
		if (!flags) return {};
		if (flags !== 1 && flags !== 3) throw new Error("binary: unknown payload flags");
		const value = this.part();
		if (flags === 1) return { [key]: value };
		const lengths = this.list(() => this.integer());
		return { [key]: value, segments: lengths.map((size) => this.raw(size)) };
	}
	end(): void {
		if (this.#at !== this.#bytes.length) throw new Error("binary: bytes after the message");
	}
}

function writeComplex(writer: PacketWriter, message: Message): void {
	switch (message.kind) {
		case "event":
			writer.list(message.events, (event) => {
				writer.integer(event.hold);
				writer.integer(event.member);
				writer.integer(event.at);
				writer.part(event.value);
			});
			return;
		case "hold": {
			writer.integer(message.hold);
			writer.text(message.type);
			writer.integer(message.version);
			writer.field("hex", message.fingerprint);
			writer.part(message.params);
			const { address, principal, incarnation, chain, limit } = message;
			writer.text(address.kind);
			writer.json(address.params);
			const optionals: [unknown, () => void][] = [
				[principal, () => writer.json(principal)],
				[incarnation, () => writer.field("uuid", incarnation)],
				[chain, () => writer.list(chain!, (value) => writer.field("uuid", value))],
				[limit, () => writer.integer(limit!)],
			];
			writer.byte(optionals.reduce((flags, [value], index) => flags | (value === undefined ? 0 : 1 << index), 0));
			for (const [value, write] of optionals) if (value !== undefined) write();
			return;
		}
		case "retry":
			writer.integer(message.hold);
			writer.integer(message.hops);
			return;
		case "call":
			writer.integer(message.call);
			writer.integer(message.hold);
			writer.integer(message.method);
			writer.payload(message.args, message.segments);
			return;
		case "result":
			writer.integer(message.call);
			writer.payload(message.value, message.segments);
			return;
		case "bound":
		case "state": {
			writer.integer(message.holds.length);
			if (message.kind === "bound")
				for (const entry of message.holds) {
					writer.integer(entry.hold);
					writer.integer(entry.variant);
					writer.list(entry.members, ({ member, value }) => {
						writer.integer(member);
						writer.part(value);
					});
					writer.integer(entry.failed.length);
					writer.failures(entry.failed);
				}
			else
				for (const entry of message.holds) {
					writer.integer(entry.hold);
					writer.list(entry.members, ({ member, ops }) => {
						writer.integer(member);
						writer.part(ops);
					});
					writer.integer(entry.failed.length * 2 + Number(entry.retired.length > 0));
					writer.failures(entry.failed);
					if (entry.retired.length) writer.list(entry.retired, (member) => writer.integer(member));
				}
			return;
		}
		case "failed":
			writer.integer(message.hold);
			writer.byte(CAUSE_KINDS.indexOf(message.cause.kind));
			writer.json(message.cause.error);
			writer.integer(message.retryIn === undefined ? 0 : message.retryIn + 1);
			return;
		default:
			throw new Error("binary: an unknown kind");
	}
}
function readComplex(reader: PacketReader, kind: Message["kind"]): Record<string, unknown> {
	switch (kind) {
		case "event":
			return {
				kind,
				events: reader.list(() => ({
					hold: reader.integer(),
					member: reader.integer(),
					at: reader.integer(),
					value: reader.part(),
				})),
			};
		case "hold": {
			const hold = reader.integer(),
				type = reader.field("text"),
				version = reader.integer(),
				fingerprint = reader.field("hex"),
				params = reader.part();
			const address = {
					kind: reader.field("text"),
					params: reader.field("json"),
				},
				flags = reader.byte();
			if (flags > 15) throw new Error("binary: unknown hold flags");
			return {
				kind,
				hold,
				type,
				version,
				fingerprint,
				params,
				address,
				...(flags & 1 ? { principal: reader.field("json") } : {}),
				...(flags & 2 ? { incarnation: reader.field("uuid") } : {}),
				...(flags & 4 ? { chain: reader.list(() => reader.field("uuid")) } : {}),
				...(flags & 8 ? { limit: reader.integer() } : {}),
			};
		}
		case "retry":
			return { kind, hold: reader.integer(), hops: reader.integer() };
		case "call":
			return {
				kind,
				call: reader.integer(),
				hold: reader.integer(),
				method: reader.integer(),
				...reader.payload("args"),
			};
		case "result":
			return { kind, call: reader.integer(), ...reader.payload("value") };
		case "bound":
			return {
				kind,
				holds: reader.list(() => ({
					hold: reader.integer(),
					variant: reader.integer(),
					members: reader.list(() => ({
						member: reader.integer(),
						value: reader.part(),
					})),
					failed: reader.failures(),
				})),
			};
		case "state":
			return {
				kind,
				holds: reader.list(() => {
					const hold = reader.integer(),
						members = reader.list(() => ({
							member: reader.integer(),
							ops: reader.part(),
						})),
						flags = reader.integer();
					return {
						hold,
						members,
						failed: reader.failures(Math.floor(flags / 2)),
						retired: flags % 2 ? reader.list(() => reader.integer()) : NO_RETIRED,
					};
				}),
			};
		case "failed": {
			const hold = reader.integer(),
				cause = CAUSE_KINDS[reader.byte()];
			if (cause === undefined) throw new Error("binary: an unknown failure kind");
			const error = reader.field("json"),
				delay = reader.integer();
			return {
				kind,
				hold,
				cause: { kind: cause, error },
				...(delay ? { retryIn: delay - 1 } : {}),
			};
		}
		default:
			throw new Error("binary: an unknown kind");
	}
}
export const binaryCodec: Codec = {
	name: "binary",
	encode(message) {
		const writer = new PacketWriter(),
			code = kinds.indexOf(message.kind),
			origin = "origin" in message ? message.origin : undefined,
			trace = message.kind === "hold" || message.kind === "call" ? message.trace : undefined;
		const flag =
			(message.kind === "call" && message.old === true) || (message.kind === "ack" && message.events !== undefined);
		writer.byte(code | (origin === undefined ? 0 : 128) | (trace === undefined ? 0 : 64) | (flag ? 32 : 0));
		if (origin !== undefined) writer.integer(origin);
		if (trace !== undefined) writer.json(trace);
		const layout = layouts.get(message.kind);
		if (layout)
			for (const [field, type] of layout)
				writer.field(
					type,
					message.kind === "hello" && field === "calls" ? (message.calls ?? 0) : Reflect.get(message, field),
				);
		else writeComplex(writer, message);
		if (message.kind === "ack" && message.events !== undefined) writer.integer(message.events);
		return writer.finish();
	},
	decode(bytes) {
		const reader = new PacketReader(bytes),
			tag = reader.byte(),
			kind = kinds[tag & 31];
		if (kind === undefined) throw new Error("binary: an unknown kind");
		if (tag & 32 && kind !== "call" && kind !== "ack") throw new Error("binary: an unknown kind");
		const origin = tag & 128 ? reader.integer() : undefined;
		const trace = tag & 64 ? reader.field("json") : undefined;
		const layout = layouts.get(kind),
			value =
				kind === "ack" && tag & 32
					? { kind, events: reader.integer() }
					: layout
						? {
								kind,
								...(kind === "closed" ? { origin: 0 } : {}),
								...Object.fromEntries(layout.map(([field, type]) => [field, reader.field(type)])),
							}
						: readComplex(reader, kind);
		reader.end();
		if (origin !== undefined) value.origin = origin;
		if (trace !== undefined) value.trace = trace;
		if (kind === "call" && tag & 32) value.old = true;
		if (kind === "hello" && value.calls === 0) delete value.calls;
		// Parts stay opaque. Schema validation belongs to the receiving channel.
		return value as Message;
	},
};
