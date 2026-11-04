import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { bool, int, obj, opt, str } from "../src/next/contracts/index.ts";
import { Claims } from "../src/next/store/claims.ts";
import { describeColumns } from "../src/next/store/columns.ts";
import { json } from "../src/next/store/json-column.ts";
import { RowCodec } from "../src/next/store/rows.ts";

describe("stored rows", () => {
	it("preserves thrown migration causes and leaves an absent cause absent", () => {
		for (const cause of [undefined, null, false, 0, "bad", new Error("migration failed")]) {
			const column = json(str(), { version: 2, migrate() { throw cause } });
			let failure: unknown;
			try { column.json.read('"old"', 1, "notes.title", context) } catch (error) { failure = error }
			expect(failure).toMatchObject({ code: "unavailable", message: "notes.title: migrate from version 1 threw" });
			if (!(failure instanceof Error)) throw new Error("Expected a migration error");
			expect(Object.hasOwn(failure, "cause")).toBe(cause !== undefined);
			expect(failure.cause).toBe(cause);
		}
	});
	it("encodes rows and keys consistently and decodes optional, boolean and JSON cells", () => {
		const columns = describeColumns(
			{
				id: str(),
				count: int({ default: 3 }),
				enabled: bool(),
				note: opt(str()),
				meta: json(obj({ n: int() }), { version: 2 }),
			},
			"items",
		);
		const rows = new RowCodec(columns, ["id"], "items");
		const encoded = rows.put({ id: "item", enabled: true, meta: { n: 2 } }, 4);
		expect(encoded.params).toEqual(["item", 3, 1, null, '{"n":2}', 2, 4]);
		expect(encoded.row).toEqual({
			id: "item",
			count: 3,
			enabled: true,
			meta: { n: 2 },
		});
		expect(encoded.columns).toEqual({ meta: 2 });
		expect(encoded.id).toBe(rows.key({ id: "item" }, "get").id);
		expect(
			rows.decode(
				{
					id: "item",
					count: 3,
					enabled: 0,
					note: null,
					meta: '{"n":2}',
					meta$v: 2,
				},
				context,
			),
		).toEqual({ id: "item", count: 3, enabled: false, meta: { n: 2 } });
	});
	it("rejects malformed writes during staging, without schema-walking valid JSON cells", () => {
		const rows = new RowCodec(
			describeColumns(
				{ id: str(), meta: json(obj({ n: int() }), { version: 1 }) },
				"items",
			),
			["id"],
			"items",
		);
		expect(() => rows.put({ id: "a", meta: {}, extra: 1 }, 1)).toThrow(
			'unknown column "extra"',
		);
		expect(() => rows.put({ id: "a\0", meta: {} }, 1)).toThrow("NUL");
		expect(() => rows.key({}, "get")).toThrow("is missing");
		expect(() => rows.put({ id: "a", meta: { n: 1n } }, 1)).toThrow(
			expect.objectContaining({ code: "invalid", reason: "args" }),
		);
		expect(rows.put({ id: "a", meta: {} }, 1).params).toEqual([
			"a",
			"{}",
			1,
			1,
		]);
	});
	it("claims tables and document namespaces by owner and releases all of one owner's claims", () => {
		const claims = new Claims();
		const one = { label: "one" },
			two = { label: "two" };
		claims.table("app:items", one);
		claims.documents("app", "session", one);
		expect(() => claims.table("app:items", two)).toThrow("claimed by one");
		claims.release(one);
		claims.table("app:items", two);
		const unlock = claims.lock();
		expect(() => claims.documents("app", "session", two)).toThrow(
			"while a batch applies",
		);
		unlock();
		claims.release(two);
		expect(claims.held).toBe(false);
	});
});
