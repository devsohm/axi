import { expect, test } from "vitest";
import { parsePayload, payloadPart } from "../src/next/link/values.ts";

test("byte segments preserve a Buffer subview despite its JSON conversion", () => {
	const bytes = Buffer.from([1, 2, 3, 4]).subarray(1, 3);
	const payload = payloadPart({ bytes }, true);
	expect(payload.segments).toEqual([bytes]);
	expect(parsePayload(payload.json, payload.segments)).toEqual({ bytes });
	expect([...payload.segments![0]!]).toEqual([2, 3]);
});
