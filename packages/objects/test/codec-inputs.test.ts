import { expect, test } from "vitest";
import { binaryCodec, describeMessage, textCodec, type Message } from "../src/index.ts";

test.each([binaryCodec, textCodec])("$name reads trace carriers only from holds and calls", (codec) => {
	const message = {
		kind: "release" as const,
		hold: 1,
		get trace() {
			throw new Error("This message has no trace carrier");
		},
	};
	expect(codec.decode(codec.encode(message))).toEqual({ kind: "release", hold: 1 });
});

test.each([binaryCodec, textCodec])("$name encodes one address and principal snapshot per hold", (codec) => {
	let addresses = 0,
		principals = 0;
	const message: Extract<Message, { kind: "hold" }> = {
		kind: "hold",
		hold: 1,
		type: "item",
		version: 1,
		fingerprint: "0123456789abcdef",
		params: "{}",
		get address() {
			return { kind: `server-${++addresses}`, params: { revision: addresses } };
		},
		get principal() {
			return { kind: `user-${++principals}` };
		},
	};
	expect(codec.decode(codec.encode(message))).toMatchObject({
		address: { kind: "server-1", params: { revision: 1 } },
		principal: { kind: "user-1" },
	});
	expect({ addresses, principals }).toEqual({ addresses: 1, principals: 1 });
});

test("message descriptions capture the origin before formatting the inner envelope", () => {
	let origins = 0;
	const message: Message = {
		kind: "release",
		hold: 1,
		get origin() {
			return ++origins;
		},
	};
	expect(describeMessage(message)).toBe('["@",1,["R",1]]');
	expect(origins).toBe(1);
});

test("message descriptions read the call trace once", () => {
	let traces = 0;
	const message: Message = {
		kind: "call",
		call: 1,
		hold: 2,
		method: 0,
		get trace() {
			return { attempt: String(++traces) };
		},
	};
	expect(describeMessage(message)).toBe('["c",1,2,0,null,null,{"attempt":"1"}]');
	expect(traces).toBe(1);
});
