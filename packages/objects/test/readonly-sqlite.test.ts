import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";

test("a read-only SQLite connection reads committed rows during a writer transaction and rejects writes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-readonly-"));
	const path = join(directory, "rows.sqlite");
	const writer = await openNodeSqliteDatabase(path);
	let reader: Awaited<ReturnType<typeof openNodeSqliteDatabase>> | undefined;
	const release = Promise.withResolvers<void>();
	let writing: Promise<void> | undefined;
	try {
		await writer.exec("CREATE TABLE rows(value INTEGER); INSERT INTO rows VALUES(1)");
		reader = await openNodeSqliteDatabase(path, { mode: "read-only", busyTimeoutMs: 0 });
		const entered = Promise.withResolvers<void>();
		writing = writer.transaction(async (transaction) => {
			await transaction.run("INSERT INTO rows VALUES(2)");
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		expect(await reader.transaction((transaction) => transaction.all("SELECT value FROM rows"))).toEqual([
			{ value: 1 },
		]);
		await expect(reader.run("INSERT INTO rows VALUES(3)")).rejects.toThrow();
	} finally {
		release.resolve();
		await writing;
		await reader?.close();
		await writer.close();
		await rm(directory, { recursive: true, force: true });
	}
});
