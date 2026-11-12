import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { binaryCodec } from "../src/link/binary.ts";
import { checkMessage } from "../src/link/message.ts";
import { DeflatedPart } from "../src/link/part.ts";
import { parsePart, parsePayload } from "../src/link/values.ts";

it("terminates when given negative identifiers", () => {
	const module = new URL("../src/link/index.ts", import.meta.url).href;
	const result = spawnSync(
		process.execPath,
		[
			"--conditions=source",
			"--input-type=module",
			"-e",
			`import { binaryCodec } from ${JSON.stringify(module)};
			 console.log(JSON.stringify([-1, -2, -128, -129, -256, -300].map(hold =>
			  [...binaryCodec.encode({ kind: "release", hold })])));`,
		],
		{ encoding: "utf8", timeout: 4000 },
	);
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual([
		[2, 255],
		[2, 254],
		[2, 128],
		[2, 127],
		[2, 0],
		[2, 212],
	]);
});

it("writes protocol tags, safe-integer varints, origin flags and retirement indexes", () => {
	expect([...binaryCodec.encode({ kind: "release", hold: 300 })]).toEqual([
		2, 172, 2,
	]);
	expect([...binaryCodec.encode({ kind: "ack", origin: 300 })]).toEqual([
		141, 172, 2,
	]);
	expect([
		...binaryCodec.encode({
			kind: "state",
			holds: [{ hold: 0, members: [], failed: [], retired: [3] }],
		}),
	]).toEqual([6, 1, 0, 0, 1, 1, 3]);
	expect(
		binaryCodec.decode(
			binaryCodec.encode({ kind: "release", hold: Number.MAX_SAFE_INTEGER }),
		),
	).toEqual({ kind: "release", hold: Number.MAX_SAFE_INTEGER });
	for (const bytes of [
		[],
		[99],
		[2, ...Array(9).fill(255)],
		[1, 0, 9, 97],
		[13, 0],
	])
		expect(() => binaryCodec.decode(new Uint8Array(bytes))).toThrow();
});
it("receives opaque parts and raw payload segments as views of the original message", () => {
	const bytes = binaryCodec.encode({
		kind: "result",
		call: 3,
		value: '{"data":{"$bytes":0}}',
		segments: [new Uint8Array([1, 3, 5])],
	});
	const decoded = checkMessage(binaryCodec.decode(bytes), context);
	if (decoded.kind !== "result" || !(decoded.value instanceof Uint8Array))
		throw new Error("Unexpected payload");
	expect(decoded.value.buffer).toBe(bytes.buffer);
	expect(decoded.segments?.[0]?.buffer).toBe(bytes.buffer);
	expect(parsePayload(decoded.value, decoded.segments)).toEqual({
		data: new Uint8Array([1, 3, 5]),
	});
	const compressed = binaryCodec.decode(
		binaryCodec.encode({
			kind: "result",
			call: 1,
			value: new DeflatedPart(new Uint8Array([7, 8])),
		}),
	);
	expect(compressed).toEqual({
		kind: "result",
		call: 1,
		value: new DeflatedPart(new Uint8Array([7, 8])),
	});
	const invalid = binaryCodec.decode(
		binaryCodec.encode({ kind: "result", call: 1, value: "{" }),
	);
	if (invalid.kind !== "result" || !(invalid.value instanceof Uint8Array))
		throw new Error("Unexpected payload");
	const malformed = invalid.value;
	expect(() => parsePart(malformed)).toThrow();
});
it("keeps Unicode data across buffer growth and bounds the retained backing allocation", () => {
	for (const text of ["€".repeat(42), "😀".repeat(5000), "x".repeat(500000)]) {
		const bytes = binaryCodec.encode({
			kind: "result",
			call: 2,
			value: JSON.stringify(text),
		});
		const decoded = binaryCodec.decode(bytes);
		if (decoded.kind !== "result" || !(decoded.value instanceof Uint8Array))
			throw new Error("Unexpected payload");
		expect(parsePart(decoded.value)).toBe(text);
		expect(bytes.buffer.byteLength - bytes.byteLength).toBeLessThanOrEqual(
			4096,
		);
	}
});
