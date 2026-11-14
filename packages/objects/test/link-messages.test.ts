import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { ObjectsError, PluginError } from "../src/data/index.ts";
import { checkMessage, errorFromWire, wireError } from "../src/link/internal.ts";

it("accepts the protocol's message envelopes and enforces identifiers and allowed fields", () => {
	const good: unknown[] = [
		{
			kind: "hello",
			protocol: 1,
			incarnation: "0190f5a2-7c3e-7d4a-9b1c-2d3e4f5a6b7c",
			calls: 256,
		},
		{ kind: "ack", origin: 1 },
		{
			kind: "state",
			holds: [{ hold: 0, members: [], failed: [], retired: [3] }],
		},
	];
	for (const value of good) expect(checkMessage(value, context)).toBe(value);
	for (const value of [
		{ kind: "hello", protocol: 1, incarnation: "invalid", calls: 256 },
		{ kind: "ack", origin: 0 },
		{ kind: "release", hold: -1 },
		{ kind: "closed" },
		{ kind: "ping", origin: 1 },
		{ kind: "state", holds: [{ hold: 0, members: [], failed: [] }] },
	])
		expect(() => checkMessage(value, context)).toThrow("message schema");
});
it("preserves public error fields through JSON while leaving private causes behind", () => {
	const source = new ObjectsError(
		{ code: "invalid", reason: "args", message: "invalid args" },
		{ cause: new Error("private") },
	);
	const wire = wireError(source);
	expect(wire).toEqual({
		kind: "objects",
		error: { code: "invalid", reason: "args", message: "invalid args" },
	});
	const restored = errorFromWire(JSON.parse(JSON.stringify(wire)));
	expect(restored).toMatchObject({
		code: "invalid",
		reason: "args",
		message: "invalid args",
	});
	expect(restored.cause).toBeUndefined();
	const plugin = errorFromWire(wireError(new PluginError("limit", "over quota", { remaining: 0 })));
	expect(plugin).toMatchObject({
		code: "limit",
		message: "over quota",
		details: { remaining: 0 },
	});
	expect(wireError(new TypeError("failed"))).toEqual({
		kind: "plugin",
		code: "internal",
		message: "failed",
	});
	expect(() =>
		errorFromWire({
			kind: "objects",
			error: { code: "unknown", message: "invalid" },
		}),
	).toThrow("Invalid ObjectsError JSON");
});
