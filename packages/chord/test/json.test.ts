import { describe, expect, it } from "vitest";
import { copyJson, isJsonValue } from "../src/index.ts";

describe("JSON values", () => {
	it("preserves primitive values and negative zero", () => {
		expect(copyJson([null, false, "", 0, -0])).toEqual([null, false, "", 0, -0]);
		expect(Object.is(copyJson(-0), -0)).toBe(true);
		expect(isJsonValue(false)).toBe(true);
		for (const value of [undefined, NaN, Infinity, 2n, Symbol(), () => 1]) {
			expect(isJsonValue(value)).toBe(false);
			expect(() => copyJson(value)).toThrow(TypeError);
		}
	});

	it("copies shared children into separate writable trees", () => {
		const child = Object.freeze({ count: 3 });
		const input = Object.freeze({ first: child, second: child });
		const result = copyJson(input);
		expect(result).toEqual({ first: { count: 3 }, second: { count: 3 } });
		expect(Object.getOwnPropertyDescriptor(result, "first")).toEqual({
			value: { count: 3 },
			enumerable: true,
			writable: true,
			configurable: true,
		});
		if (result === null || typeof result !== "object" || Array.isArray(result)) throw new Error("Expected an object");
		expect(result.first).not.toBe(result.second);
		expect(result.first).not.toBe(child);
	});

	it("checks descriptors without invoking accessors or toJSON", () => {
		let invocations = 0;
		const accessor = Object.defineProperty({}, "secret", {
			enumerable: true,
			get() {
				invocations++;
				return 1;
			},
		});
		expect(isJsonValue(accessor)).toBe(false);
		expect(() => copyJson(accessor)).toThrow(TypeError);
		expect(invocations).toBe(0);
		const custom = {
			toJSON() {
				invocations++;
				return null;
			},
		};
		expect(isJsonValue(custom)).toBe(false);
		expect(() => copyJson(custom)).toThrow(TypeError);
		expect(invocations).toBe(0);
		expect(copyJson({ secret: 1 })).toEqual({ secret: 1 });
	});

	it("omits undefined object fields at every depth but rejects undefined array slots", () => {
		expect(copyJson({ a: undefined, b: [{ x: undefined, y: 4 }] }, { omitUndefinedProperties: true })).toEqual({
			b: [{ y: 4 }],
		});
		expect(() => copyJson({ a: [undefined] }, { omitUndefinedProperties: true })).toThrow(TypeError);
		expect(isJsonValue({ a: undefined })).toBe(false);
		expect(isJsonValue({ a: null })).toBe(true);
	});

	it("rejects cycles while accepting repeated acyclic values", () => {
		const loop: unknown[] = [];
		loop.push({ back: loop });
		expect(isJsonValue(loop)).toBe(false);
		expect(() => copyJson(loop)).toThrow(TypeError);
		const value = { n: 2 };
		expect(copyJson([value, value])).toEqual([{ n: 2 }, { n: 2 }]);
	});

	it("preserves null prototypes and treats __proto__ as ordinary data", () => {
		const input = Object.create(null);
		Object.defineProperty(input, "__proto__", { value: { local: true }, enumerable: true });
		const result = copyJson(input);
		expect(Object.getPrototypeOf(result)).toBeNull();
		expect(Object.getOwnPropertyDescriptor(result, "__proto__")).toEqual({
			value: { local: true },
			enumerable: true,
			writable: true,
			configurable: true,
		});
	});
});
