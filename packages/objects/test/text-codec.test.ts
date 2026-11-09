import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { checkMessage } from "../src/link/message.ts";
import { DeflatedPart } from "../src/link/part.ts";
import { describeMessage, textCodec } from "../src/link/text.ts";

it("keeps positional envelopes, opaque compressed parts and byte segments across a text link", () => {
	const value = {
		kind: "result",
		origin: 3,
		call: 4,
		value: new DeflatedPart(new Uint8Array([1, 2, 3])),
		segments: [new Uint8Array([8, 9])],
	} as const;
	expect(describeMessage(value)).toBe('["@",3,["r",4,[1,"AQID"],[2]]]');
	const bytes = textCodec.encode(value),
		decoded = checkMessage(textCodec.decode(bytes), context);
	expect(decoded).toEqual(value);
	if (decoded.kind !== "result") throw new Error("Unexpected message");
	expect(decoded.segments?.[0]?.buffer).toBe(bytes.buffer);
	expect(
		describeMessage({
			kind: "state",
			holds: [{ hold: 0, members: [], failed: [], retired: [2] }],
		}),
	).toBe('["s",[[0,[],[],[2]]]]');
});
it("rejects malformed framing while leaving envelope types to the channel", () => {
	const decode = (value: string) =>
		textCodec.decode(new TextEncoder().encode(value));
	for (const value of [
		'["R",1,2]',
		'["s",[[0]]]',
		'["@",1,["@",2,["a"]]]',
		'["H",0,"t",1,"0123456789abcdef",[0,{}],null]',
		'["r",1,null]',
		'["r",1,[0,7],null]',
		'["c",1,0,0,null]',
		'["c",1,0,0,[0,7],null]',
	])
		expect(() => decode(value)).toThrow();
	expect(decode('["e",0,{"kind":"invalid"}]')).toEqual({
		kind: "error",
		call: 0,
		error: { kind: "invalid" },
	});
	expect(() =>
		checkMessage(decode('["e",0,{"kind":"invalid"}]'), context),
	).toThrow("message schema");
	expect(decode('["c",1,0,0,null,null,{"traceparent":"value"}]')).toEqual({
		kind: "call", call: 1, hold: 0, method: 0, trace: { traceparent: "value" },
	});
	expect(decode('["c",1,0,0,[0,7],null,{"traceparent":"value"}]')).toEqual({
		kind: "call", call: 1, hold: 0, method: 0, args: "7", trace: { traceparent: "value" },
	});
});
