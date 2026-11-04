import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import type { JsonValue } from "../src/json.ts";
import { int, local, method } from "../src/next/index.ts";
import { attachDerives, checkImplementation } from "../src/next/host/members.ts";
import { Batch, Constant, Derive } from "../src/next/state/internal.ts";

it("requires own contract members and calls no-argument methods with the context alone", async () => {
	const contract = local("test.members", {
		version: 1,
		params: {},
		members: { n: int(), toString: method() },
	});
	const n = new Constant<JsonValue>(3),
		calls: unknown[] = [];
	expect(() => checkImplementation(contract, { n })).toThrow("toString: a method is a function");
	expect(() => checkImplementation(contract, { n, extra: true, toString() {} })).toThrow("extra: not a member");
	const { members } = checkImplementation(contract, {
		n,
		toString: async (...args: unknown[]) => {
			calls.push(args);
			return null;
		},
	});
	expect(members.state.get("n")?.value).toBe(3);
	await members.methods.get("toString")?.(null, context);
	expect(calls).toEqual([[context]]);
});
it("resolves declared derives and identifies a bad source by its exposed member", () => {
	const batch = new Batch(() => {}, undefined),
		source = new Constant<JsonValue>(4),
		reports: unknown[] = [];
	const derive = new Derive([source], ([value]) => Number(value) * 2, batch);
	attachDerives([derive], new Map([["double", derive]]), (member) => (error) => {
		reports.push([member, error]);
	});
	expect(derive.value).toBe(8);
	expect(reports).toEqual([]);
	const invalid = new Derive([{}], () => 0, batch);
	expect(() => attachDerives([invalid], new Map([["bad", invalid]]), () => () => {})).toThrow("bad: source 0");
});
