import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applySqliteMigrations, type SqliteExecutor, type SqliteMigration } from "../src/sqlite/index.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import { DurableObjectSqliteDatabase } from "../src/sqlite/cloudflare.ts";

describe("SQLite persistence", () => {
	it("reads checkpoint settings before the connection timeout", async () => {
		const reads: string[] = [];
		const database = await openNodeSqliteDatabase(":memory:", {
			get walAutoCheckpointPages() {
				reads.push("checkpoint");
				return 1000;
			},
			get busyTimeoutMs() {
				reads.push("timeout");
				return 50;
			},
		});
		try {
			expect(reads).toEqual(["checkpoint", "timeout"]);
		} finally {
			await database.close();
		}
	});

	it("settles queued storage reads after the transaction and executor promises", async () => {
		let tick = 0;
		const events: [string, number][] = [];
		const timer = (async () => {
			for (let index = 0; index < 30; index++) {
				await Promise.resolve();
				tick++;
			}
		})();
		const record = (name: string) => {
			events.push([name, tick]);
		};
		const database = new DurableObjectSqliteDatabase({
			sql: {
				exec(query) {
					record(query);
					return { next: () => ({ done: false, value: { n: 1 } }), toArray: () => [{ n: 1 }] };
				},
			},
			async transaction(callback) {
				record("begin");
				const result = await callback();
				record("commit");
				return result;
			},
		});
		const transaction = database.transaction(async (handle) => {
			await handle.run("inside");
			record("inside-resolved");
		});
		const outside = database.get("outside").then(() => record("outside-resolved"));
		await Promise.all([transaction.then(() => record("transaction-resolved")), outside]);
		await timer;
		expect(events).toEqual([
			["begin", 1],
			["inside", 1],
			["inside-resolved", 2],
			["commit", 4],
			["transaction-resolved", 9],
			["outside", 10],
			["outside-resolved", 16],
		]);
		await database.close();
	});
	it("restores committed rows from an independently reopened file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-db-"));
		const path = join(directory, "nested", "state.sqlite");
		let database = await openNodeSqliteDatabase(path);
		try {
			await database.transaction(async (transaction) => {
				await transaction.exec("CREATE TABLE records (id INTEGER, payload BLOB) STRICT");
				await transaction.run("INSERT INTO records VALUES (?, ?)", 3, new Uint8Array([7, 9]));
			});
			await database.close();
			database = await openNodeSqliteDatabase(path);
			expect(await database.all("SELECT id, payload FROM records")).toEqual([
				{ id: 3, payload: new Uint8Array([7, 9]) },
			]);
		} finally {
			await database.close();
			await rm(directory, { recursive: true });
		}
	});

	it("expires reads as well as writes when a transaction finishes", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		try {
			const handle = await database.transaction(async (transaction): Promise<SqliteExecutor> => {
				await transaction.exec("CREATE TABLE values_ (n INTEGER)");
				await transaction.run("INSERT INTO values_ VALUES (?)", 4);
				return transaction;
			});
			await expect(handle.get("SELECT n FROM values_")).rejects.toThrow("no longer active");
			await expect(handle.all("SELECT n FROM values_")).rejects.toThrow("no longer active");
			expect(await database.get("SELECT n FROM values_")).toEqual({ n: 4 });
		} finally {
			await database.close();
		}
	});

	it("rejects a sparse migration list before bootstrapping metadata", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		const migrations: SqliteMigration[] = [];
		migrations.length = 2;
		migrations[1] = { version: 2, statements: [] };
		try {
			await expect(applySqliteMigrations(database, migrations, { table: "app_schema" })).rejects.toThrow("contiguous");
			expect(await database.all("SELECT name FROM sqlite_schema")).toEqual([]);
		} finally {
			await database.close();
		}
	});
});
