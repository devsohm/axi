import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { checkMessage, type Message, type WireError } from "../src/link/message.ts";
import { describeMessage, textCodec } from "../src/link/text.ts";

const error: WireError = { kind: "plugin", code: "denied", message: "No permission" };
const incarnation = "01234567-89ab-cdef-0123-456789abcdef";
const encode = new TextEncoder();
const hold = {
	kind: "hold",
	hold: 2,
	type: "counter",
	version: 1,
	fingerprint: "0123456789abcdef",
	params: '{"start":0}',
	address: { kind: "server", params: { shard: 1 } },
} as const;
const fixed: Array<[Message, unknown[]]> = [
	[{ kind: "hello", protocol: 1, incarnation, calls: 4 }, ["h", 1, incarnation, 4]],
	[{ kind: "release", hold: 2 }, ["R", 2]],
	[{ kind: "abort", call: 3 }, ["x", 3]],
	[{ kind: "error", call: 3, error }, ["e", 3, error]],
	[{ kind: "gone", hold: 2, error }, ["g", 2, error]],
	[{ kind: "revoke", revocation: { user: "guest" } }, ["V", { user: "guest" }]],
	[{ kind: "loading", hold: 2 }, ["l", 2]],
	[{ kind: "ack" }, ["a"]],
	[{ kind: "closed", origin: 1 }, ["@", 1, ["C"]]],
	[{ kind: "ping" }, ["p"]],
	[{ kind: "pong" }, ["P"]],
	[{ kind: "retry", hold: 2, hops: 3 }, ["T", 2, 3]],
	[{ kind: "call", call: 3, hold: 2, method: 0 }, ["c", 3, 2, 0]],
	[{ kind: "result", call: 3 }, ["r", 3]],
];

test.each(fixed)(
	"%j has the documented text envelope and round-trips through channel validation",
	(message, fields) => {
		expect(describeMessage(message)).toBe(JSON.stringify(fields));
		expect(checkMessage(textCodec.decode(textCodec.encode(message)), context)).toEqual(message);
	},
);

const holdOptions: Array<Partial<Extract<Message, { kind: "hold" }>>> = [
	{},
	{ principal: { kind: "user" } },
	{ incarnation },
	{ chain: [incarnation] },
	{ limit: 0 },
	{ trace: { traceparent: "trace" } },
	{ principal: { kind: "user" }, incarnation, chain: [], limit: 1, trace: {} },
];
test.each(holdOptions)("hold optional fields survive positional gaps: %j", (optional) => {
	const message = { ...hold, ...optional };
	expect(checkMessage(textCodec.decode(textCodec.encode(message)), context)).toEqual(message);
	const header = JSON.parse(describeMessage(message));
	expect(header.slice(0, 7)).toEqual([
		"H",
		2,
		"counter",
		1,
		"0123456789abcdef",
		[0, { start: 0 }],
		["server", { shard: 1 }],
	]);
});

test.each([false, true])("calls retain trace and old-generation markers with a payload: %s", (payload) => {
	const message: Message = {
		kind: "call",
		call: 3,
		hold: 2,
		method: 0,
		...(payload ? { args: '["日本",1]' } : {}),
		trace: { traceparent: "trace" },
		old: true,
	};
	expect(checkMessage(textCodec.decode(textCodec.encode(message)), context)).toEqual(message);
	const header = JSON.parse(describeMessage(message));
	expect(header.slice(-2)).toEqual([{ traceparent: "trace" }, true]);
	if (!payload) expect(header.slice(4, 6)).toEqual([null, null]);
});

test.each([{ failed: [] }, { failed: [{ member: 1, error }] }])(
	"bound members preserve values and failure lists: %j",
	({ failed }) => {
		const message: Message = {
			kind: "bound",
			holds: [{ hold: 2, variant: 1, members: [{ member: 0, value: '{"count":2}' }], failed }],
		};
		expect(checkMessage(textCodec.decode(textCodec.encode(message)), context)).toEqual(message);
	},
);

test.each([
	{ failed: [], retired: [] },
	{ failed: [{ member: 1, error }], retired: [] },
	{ failed: [], retired: [2] },
	{ failed: [{ member: 1, error }], retired: [2] },
])("state deltas retain independent failures and retirements: %j", ({ failed, retired }) => {
	const message: Message = {
		kind: "state",
		holds: [{ hold: 2, members: [{ member: 0, ops: '[["set",2]]' }], failed, retired }],
	};
	expect(checkMessage(textCodec.decode(textCodec.encode(message)), context)).toEqual(message);
});

test.each(["transient", "broken", "waiting"] as const)("%s failures retain retry hints including zero", (kind) => {
	for (const retryIn of [undefined, 0, 100]) {
		const message: Message = {
			kind: "failed",
			hold: 2,
			cause: { kind, error },
			...(retryIn === undefined ? {} : { retryIn }),
		};
		expect(checkMessage(textCodec.decode(textCodec.encode(message)), context)).toEqual(message);
	}
});

test("call byte segments preserve empty buffers and exact offsets", () => {
	const message: Message = {
		kind: "call",
		call: 3,
		hold: 2,
		method: 0,
		args: '{"first":{"$bytes":0},"second":{"$bytes":1}}',
		segments: [new Uint8Array(0), new Uint8Array([0, 255, 10, 13])],
	};
	const encoded = textCodec.encode(message);
	const decoded = checkMessage(textCodec.decode(encoded), context);
	expect(decoded).toEqual(message);
	if (decoded.kind !== "call") throw new Error("Missing call");
	expect(decoded.segments?.[1]?.buffer).toBe(encoded.buffer);
});

test.each([
	"{}",
	"[]",
	'["unknown"]',
	'["@",1]',
	'["@",1,{}]',
	'["H",2,"t",1,"0123456789abcdef",[0,{}],[]]',
	'["b",[[2,1,[[0]]]]]',
	'["b",[[2,1,[],[[1,{},3]]]]]',
	'["s",[[2,[],null]]]',
	'["s",[[2,[],[],{}]]]',
	'["f",2,"z",{}]',
	'["r",3,[0,{}],[-1]]',
	'["r",3,[0,{}],[0.5]]',
	'["r",3,[0,{}],["1"]]',
	'["r",3,[0,{}],[9007199254740992]]',
	'["r",3,[0,{}],[2]]\nX',
	'["r",3,[0,{}],[0]]\nX',
	'["r",3]\nX',
	'["p"]\nX',
])("text framing rejects malformed envelope %s", (wire) => {
	expect(() => textCodec.decode(encode.encode(wire))).toThrow();
});

test("encoding an unknown envelope fails at the protocol boundary", () => {
	expect(() => Reflect.apply(textCodec.encode, textCodec, [{ kind: "unknown" }])).toThrow("unknown kind");
});
