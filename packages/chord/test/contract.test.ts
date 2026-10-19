import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { bind, coverage, hostFamily, hostNamed, local, method, remote } from "../src/index.ts";
import { asChordError, ChordError, runAll } from "../src/errors.ts";
import { canonicalIdentity, canonicalJson, fits, normalize } from "../src/schema.ts";
import { takesNoArgs } from "../src/contract.ts";

describe("contract boundaries", () => {
	it("builds the description before capturing the local contract header", () => {
		let version = 0;
		let input = 0;
		const contract = local("capture", {
			get version() {
				return ++version;
			},
			get input() {
				return Type.Object({}, { title: String(++input) });
			},
		});
		expect(contract.version).toBe(3);
		expect(contract.description.version).toBe(2);
		expect(contract.input).toMatchObject({ title: "2" });
		expect(contract.description.input).toMatchObject({ title: "1" });
		expect([version, input]).toEqual([3, 2]);
	});
	it("filters identity fields before sorting and reads the array item schema once", () => {
		const reads: string[] = [];
		const value = {
			get z() {
				reads.push("z");
				return 1;
			},
			get a() {
				reads.push("a");
				return 2;
			},
			get omit() {
				reads.push("omit");
				return undefined;
			},
		};
		expect(canonicalJson(value)).toBe('{"a":2,"z":1}');
		expect(reads).toEqual(["z", "a", "omit", "a", "z"]);
		let itemsReads = 0;
		const schema = Type.Array(Type.Number());
		Object.defineProperty(schema, "items", {
			get() {
				itemsReads++;
				return Type.Number();
			},
		});
		expect(canonicalIdentity(schema, [1, 2, 3])).toBe("[1,2,3]");
		expect(itemsReads).toBe(1);
	});
	it("captures one validated placement and one method description", () => {
		let hostReads = 0;
		let memberReads = 0;
		const contract = remote("read-once", {
			version: 1,
			input: Type.Object({}),
			get host() {
				hostReads++;
				return hostNamed("server");
			},
			variants: { default: {} },
		});
		Object.defineProperty(contract.description.variants.default, "run", {
			get() {
				memberReads++;
				return { kind: "method" };
			},
		});
		expect(takesNoArgs(contract, "run")).toBe(true);
		expect(contract.description.host).toEqual({ name: "server" });
		expect(hostReads).toBe(1);
		expect(memberReads).toBe(1);
	});
	it("normalizes a fresh identity without changing caller input", () => {
		const schema = Type.Object({ id: Type.String(), mode: Type.Number({ default: 0 }) });
		const supplied = { id: "one", extra: "discard" };
		const value = normalize(schema, supplied, "lookup");
		expect(value).toEqual({ id: "one", mode: 0 });
		expect(canonicalIdentity(schema, value)).toBe('{"id":"one"}');
		expect(supplied).toEqual({ id: "one", extra: "discard" });
		expect(() => normalize(schema, { id: 4 }, "lookup")).toThrow(ChordError);
	});

	it("accepts additive contracts but requires a version adapter for renamed methods", () => {
		const original = local("index", {
			version: 1,
			input: Type.Object({}),
			members: { lookup: method(Type.String(), Type.Number()) },
		});
		const extra = local("index", { ...original.def, members: { ...original.def.members, clear: method() } });
		expect(coverage(extra.description, original.description)).toBeUndefined();
		expect(bind(extra, undefined, original)).toBeUndefined();
		const renamed = local("index", {
			version: 2,
			input: Type.Object({}),
			members: { search: method(Type.String(), Type.Number()) },
		});
		expect(() => bind(renamed, undefined, original)).toThrow(/no accepts adapter/);
		const adapter = (value: Record<string, unknown>) => ({ lookup: value.search });
		expect(bind(renamed, { 1: adapter }, original)).toBe(adapter);
	});

	it("refuses to adapt objects between different placements", () => {
		const original = remote("item", {
			version: 1,
			input: Type.Object({ id: Type.String() }),
			host: hostFamily("item:", "id"),
			variants: { reader: {} },
		});
		const moved = remote("item", { ...original.def, version: 2, host: hostNamed("server") });
		expect(() => bind(moved, { 1: (value) => value }, original)).toThrow(/consumer expects/);
	});

	it("keeps schema compatibility conservative for unmodeled constraints", () => {
		expect(fits(Type.Integer(), Type.Number())).toBe(true);
		expect(fits(Type.Number(), Type.Integer())).toBe(false);
		expect(fits({ type: "number", minimum: 3 }, { type: "number", minimum: 2 })).toBe(false);
		expect(fits({ type: "number" }, { not: { type: "string" } })).toBe(false);
	});

	it("retains domain failures and runs every cleanup step in order", async () => {
		const failure = new ChordError("upgrade_conflict", "busy", { reason: "gate" });
		expect(asChordError(failure, "load")).toBe(failure);
		expect(failure.retryable).toBe(true);
		const ordinary = new Error("broken"),
			converted = asChordError(ordinary, "load");
		expect(converted.code).toBe("unavailable");
		expect(converted.cause).toBe(ordinary);
		const order: number[] = [];
		const caught = await runAll(
			[
				() => {
					order.push(1);
					throw ordinary;
				},
				async () => {
					order.push(2);
				},
				() => {
					order.push(3);
					throw failure;
				},
			],
			"cleanup",
		).catch((error: unknown) => error);
		expect(order).toEqual([1, 2, 3]);
		expect(caught).toBeInstanceOf(AggregateError);
		if (!(caught instanceof AggregateError)) throw new Error("missing aggregate");
		expect(caught.errors).toEqual([ordinary, failure]);
	});
});
