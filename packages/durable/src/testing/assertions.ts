import type { StorageConformanceAssertions } from "./types.ts";

export type ExpectLike = (actual: unknown, message?: string) => unknown;
type Match = {
	toBe(value: unknown): unknown;
	toBeGreaterThan(value: number): unknown;
	toEqual(value: unknown): unknown;
	toMatchObject(value: unknown): unknown;
	toBeTruthy(): unknown;
	readonly rejects: { toThrow(value?: string | RegExp): unknown };
};
export function createExpectAssertions(expect: ExpectLike): StorageConformanceAssertions {
	const match = (value: unknown, message?: string) => expect(value, message) as Match;
	return {
		ok: (value, message) => {
			match(value, message).toBeTruthy();
		},
		strictEqual: (actual, expected) => {
			match(actual).toBe(expected);
		},
		deepEqual: (actual, expected) => {
			match(actual).toEqual(expected);
		},
		partialDeepEqual: (actual, expected) => {
			match(actual).toMatchObject(expected);
		},
		greaterThan: (actual, expected) => {
			match(actual).toBeGreaterThan(expected);
		},
		rejects: async (operation, message) => {
			await match(operation).rejects.toThrow(message);
		},
	};
}
