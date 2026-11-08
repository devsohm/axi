import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { DurableObjectSqliteDatabase, type DurableObjectSqliteStorage } from "../src/sqlite/cloudflare.ts";
import type { SqliteExecutor } from "../src/sqlite/database.ts";

function fixture() {
	const native = new DatabaseSync(":memory:");
	const storage: DurableObjectSqliteStorage = {
		sql: {
			exec(query, ...bindings) {
				const values = native
					.prepare(query)
					.all(...bindings.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value)));
				const rows = values.map((row) => {
					const mapped: Record<string, string | number | null | ArrayBuffer> = {};
					for (const [key, value] of Object.entries(row))
						mapped[key] =
							value instanceof Uint8Array
								? Uint8Array.from(value).buffer
								: typeof value === "bigint"
									? Number(value)
									: value;
					return mapped;
				});
				let index = 0;
				return {
					next: () => (index < rows.length ? { done: false, value: rows[index++]! } : { done: true }),
					toArray: () => rows.slice(index),
				};
			},
		},
		async transaction(callback) {
			native.exec("BEGIN");
			try {
				const result = await callback();
				native.exec("COMMIT");
				return result;
			} catch (error) {
				native.exec("ROLLBACK");
				throw error;
			}
		},
	};
	return { native, storage, database: new DurableObjectSqliteDatabase(storage) };
}

test("Durable Object SQLite binds supported values and decodes blob rows from both cursor APIs", async () => {
	const { database, native } = fixture();
	try {
		await database.exec("CREATE TABLE records (id INTEGER, label TEXT, payload BLOB, empty TEXT)");
		expect(
			await database.runCounted("INSERT INTO records VALUES (?, ?, ?, ?)", 1n, "first", new Uint8Array([3, 4]), null),
		).toBe(1);
		await database.run("INSERT INTO records VALUES (?, ?, ?, ?)", 2, "second", new Uint8Array([5]), null);
		expect(await database.get("SELECT * FROM records WHERE id = ?", 1)).toEqual({
			id: 1,
			label: "first",
			payload: new Uint8Array([3, 4]),
			empty: null,
		});
		expect(await database.all("SELECT * FROM records ORDER BY id")).toEqual([
			{ id: 1, label: "first", payload: new Uint8Array([3, 4]), empty: null },
			{ id: 2, label: "second", payload: new Uint8Array([5]), empty: null },
		]);
		expect(await database.get("SELECT * FROM records WHERE id = ?", 3)).toBeUndefined();
		expect(await database.all("SELECT * FROM records WHERE id = ?", 3)).toEqual([]);
		expect(await database.runCounted("DELETE FROM records WHERE id = ?", 3)).toBe(0);
	} finally {
		await database.close();
		native.close();
	}
});

test("bigint binding rejects precision loss before admitting a database write", async () => {
	const { database, native } = fixture();
	try {
		await database.exec("CREATE TABLE numbers (n INTEGER)");
		for (const value of [BigInt(Number.MIN_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER)]) {
			await database.run("INSERT INTO numbers VALUES (?)", value);
			expect(await database.get("SELECT n FROM numbers WHERE n = ?", value)).toEqual({ n: Number(value) });
		}
		for (const value of [BigInt(Number.MIN_SAFE_INTEGER) - 1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n])
			await expect(database.run("INSERT INTO numbers VALUES (?)", value)).rejects.toBeInstanceOf(RangeError);
		expect(await database.get("SELECT count(*) AS count FROM numbers")).toEqual({ count: 2 });
	} finally {
		await database.close();
		native.close();
	}
});

test("typed byte views and Buffer views retain their selected binding contracts", async () => {
	const { database, native } = fixture();
	try {
		const bytes = new Uint8Array([1, 2, 3, 4]),
			buffer = Buffer.from(new ArrayBuffer(4));
		buffer.set(bytes);
		expect(await database.get("SELECT ? AS payload", bytes.subarray(1, 3))).toEqual({
			payload: new Uint8Array([2, 3]),
		});
		expect(await database.get("SELECT ? AS payload", buffer.subarray(1, 3))).toEqual({
			payload: new Uint8Array([1, 2, 3, 4]),
		});
	} finally {
		await database.close();
		native.close();
	}
});

test("wrappers over one Durable Object share admission and outside reads wait for transaction completion", async () => {
	const { database, storage, native } = fixture(),
		second = new DurableObjectSqliteDatabase(storage);
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	await database.exec("CREATE TABLE counter (n INTEGER)");
	await database.run("INSERT INTO counter VALUES (0)");
	const writing = database.transaction(async (tx) => {
		await tx.run("UPDATE counter SET n = 1");
		entered.resolve();
		await release.promise;
		await tx.run("UPDATE counter SET n = 2");
	});
	let read = false,
		closed = false;
	try {
		await entered.promise;
		const outside = second.get("SELECT n FROM counter").then((value) => {
			read = true;
			return value;
		});
		const closing = second.close().then(() => {
			closed = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(read).toBe(false);
		expect(closed).toBe(false);
		release.resolve();
		await writing;
		expect(await outside).toEqual({ n: 2 });
		await closing;
		expect(read).toBe(true);
		expect(closed).toBe(true);
	} finally {
		release.resolve();
		await writing;
		await database.close();
		native.close();
	}
});

test("independent Durable Object storages do not share the same transaction queue", async () => {
	const first = fixture(),
		second = fixture(),
		entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const writing = first.database.transaction(async () => {
		entered.resolve();
		await release.promise;
	});
	try {
		await entered.promise;
		expect(await second.database.get("SELECT 42 AS value")).toEqual({ value: 42 });
	} finally {
		release.resolve();
		await writing;
		await first.database.close();
		await second.database.close();
		first.native.close();
		second.native.close();
	}
});

test.each([false, true])("transaction handles expire after callback settlement, rollback: %s", async (rollback) => {
	const { database, native } = fixture();
	let handle: SqliteExecutor | undefined;
	const failure = new Error("Transaction rolled back");
	try {
		await database.exec("CREATE TABLE items (n INTEGER)");
		const transaction = database.transaction(async (tx) => {
			handle = tx;
			await tx.run("INSERT INTO items VALUES (7)");
			if (rollback) throw failure;
			return tx.all("SELECT n FROM items");
		});
		if (rollback) await expect(transaction).rejects.toBe(failure);
		else expect(await transaction).toEqual([{ n: 7 }]);
		if (!handle) throw new Error("Missing transaction handle");
		const expired = handle;
		for (const invoke of [
			() => expired.exec("SELECT 1"),
			() => expired.run("SELECT 1"),
			() => expired.runCounted("SELECT 1"),
			() => expired.get("SELECT 1"),
			() => expired.all("SELECT 1"),
		])
			await expect(invoke()).rejects.toThrow("no longer active");
		expect(await database.all("SELECT n FROM items")).toEqual(rollback ? [] : [{ n: 7 }]);
		await database.run("INSERT INTO items VALUES (9)");
		expect(await database.get("SELECT max(n) AS n FROM items")).toEqual({ n: 9 });
	} finally {
		await database.close();
		native.close();
	}
});

test("a missing storage changes row is represented as zero changed records", async () => {
	const database = new DurableObjectSqliteDatabase({
		sql: { exec: () => ({ next: () => ({ done: true }), toArray: () => [] }) },
		transaction: (callback) => callback(),
	});
	expect(await database.runCounted("write")).toBe(0);
	await database.close();
});
