import { expect, it } from "vitest";
import { int, opt, str } from "../src/next/contracts/index.ts";
import {
	add,
	coalesce,
	ColumnRef,
	compileSet,
	compileWhere,
	eq,
	prefix,
} from "../src/next/store/expression.ts";
import { defineTable } from "../src/next/store/table.ts";

it("normalizes a row and keeps table fingerprints independent of declaration order", () => {
	const first = defineTable("events", {
		version: 1,
		columns: { id: str(), score: int({ default: 4 }) },
		key: ["id"],
	});
	const reordered = defineTable("events", {
		version: 1,
		columns: { score: int({ default: 4 }), id: str() },
		key: ["id"],
	});
	expect(first.fingerprint).toBe(reordered.fingerprint);
	expect(first.rows.put({ id: "a" }, 1).params).toEqual(["a", 4, 1]);
	expect(() =>
		defineTable("invalid", {
			version: 1,
			columns: { id: str() },
			key: ["id", "id"],
		}),
	).toThrow("twice");
});
it("compiles nullable arithmetic only after a fallback and protects primary keys", () => {
	const table = defineTable("counters", {
		version: 1,
		columns: { id: str(), n: int(), previous: opt(int()) },
		key: ["id"],
	});
	const previous = new ColumnRef<number, "int">("previous");
	expect(
		compileSet(table, { n: add(coalesce(previous, 0), 2) }, "update"),
	).toEqual({ n: { add: [{ coalesce: [{ col: "previous" }, 0] }, 2] } });
	expect(() => compileSet(table, { n: table.refs.previous }, "update")).toThrow(
		"may be NULL",
	);
	expect(() => compileSet(table, { id: "other" }, "update")).toThrow(
		"cannot change",
	);
});
it("rejects null query operands and repairs surrogate text at the staging boundary", () => {
	const table = defineTable("paths", {
		version: 1,
		columns: { id: str() },
		key: ["id"],
	});
	const id = new ColumnRef<string, "str">("id");
	expect(compileWhere(table, eq(id, "a\uD800"), "where")).toEqual({
		eq: ["id", "a\uFFFD"],
	});
	expect(() => compileWhere(table, prefix(id, null as never), "where")).toThrow(
		"ask with isNull",
	);
});
