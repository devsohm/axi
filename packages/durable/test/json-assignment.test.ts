import { track, type JsonValue } from "@axi/objects/delta";
import { describe, expect, it } from "vitest";
import { assignJson } from "../src/harness/json.ts";

describe("JSON assignment", () => {
	it("preserves a prototype-named argument as data during repeated updates", () => {
		const tracker = track<{ message: JsonValue }>({ message: { arguments: { path: "a" } } });
		const change = tracker.beginChange();
		assignJson(change.state, "message", JSON.parse('{"arguments":{"path":"ab","__proto__":{"marked":true}}}'));
		tracker.adopt(change.prepare());
		expect(Object.getOwnPropertyDescriptor(Object.prototype, "marked")).toBeUndefined();
		expect(JSON.stringify(tracker.value)).toBe('{"message":{"arguments":{"path":"ab","__proto__":{"marked":true}}}}');
	});
	it("uses field plans to append strings and preserve completed values", () => {
		const tracker = track({ text: "first", finished: { answer: 42 } });
		const change = tracker.beginChange();
		assignJson(change.state, "text", "first second", { kind: "append", text: " second" });
		assignJson(change.state, "finished", { answer: 0 }, { kind: "keep" });
		tracker.adopt(change.prepare());
		expect(tracker.value).toEqual({ text: "first second", finished: { answer: 42 } });
	});
});
