import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { binaryCodec } from "../src/link/binary.ts";
import { checkMessage } from "../src/link/message.ts";
import { textCodec } from "../src/link/text.ts";
import { parsePart } from "../src/link/values.ts";

it("carries outgoing-work ancestry with and without a payload through either codec", () => {
	for (const codec of [binaryCodec, textCodec]) {
		for (const fields of [{}, { args: '{"n":4}', trace: { parent: "abc" } }]) {
			const call = { kind: "call", call: 7, hold: 1, method: 2, old: true, ...fields } as const;
			const decoded = checkMessage(codec.decode(codec.encode(call)), context);
			expect(decoded).toMatchObject({ kind: "call", call: 7, hold: 1, method: 2, old: true });
			if (decoded.kind !== "call") throw new Error("Expected a method call");
			if ("args" in fields) {
				if (typeof decoded.args !== "string" && !(decoded.args instanceof Uint8Array))
					throw new Error("Expected an uncompressed payload");
				expect(parsePart(decoded.args)).toEqual({ n: 4 });
			} else expect(decoded.args).toBeUndefined();
			if ("trace" in fields) expect(decoded.trace).toEqual(fields.trace);
		}
	}
	expect(() => checkMessage({ kind: "call", call: 7, hold: 1, method: 2, old: false }, context)).toThrow();
	const noncall = binaryCodec.encode({ kind: "ack" });
	noncall[0] = noncall[0]! | 32;
	expect(() => binaryCodec.decode(noncall)).toThrow();
});
