import type { SqliteExecutor } from "@axi/objects/sqlite";
import type { Cell } from "./rows.ts";

function* arrays(parts: readonly string[]): Generator<string> {
	let chunk: string[] = [],
		length = 2;
	for (const part of parts) {
		if (chunk.length && length + part.length + 1 > 512 * 1024) {
			yield `[${chunk.join(",")}]`;
			chunk = [];
			length = 2;
		}
		length += part.length + (chunk.length ? 1 : 0);
		chunk.push(part);
	}
	if (chunk.length) yield `[${chunk.join(",")}]`;
}
export async function readRows<Value extends object>(
	db: SqliteExecutor,
	sql: string,
	values: readonly (Cell | readonly Cell[])[],
): Promise<Value[]> {
	const result: Value[] = [];
	for (const parameter of arrays(values.map((value) => JSON.stringify(value))))
		result.push(...(await db.all<Value>(sql, parameter)));
	return result;
}
export async function deleteRows(db: SqliteExecutor, table: string, ids: readonly number[]): Promise<void> {
	for (const parameter of arrays(ids.map((value) => JSON.stringify(value))))
		await db.run(`DELETE FROM ${table} WHERE document_id IN (SELECT value FROM json_each(?))`, parameter);
}
export async function insertRows(
	db: SqliteExecutor,
	table: string,
	columns: readonly string[],
	rows: readonly (readonly Cell[])[],
	conflict = "",
): Promise<void> {
	const small: string[] = [],
		large: (readonly Cell[])[] = [];
	for (const row of rows) {
		const characters = row.reduce<number>((sum, cell) => sum + (typeof cell === "string" ? cell.length : 0), 0);
		if (characters > 8 * 1024) large.push(row);
		else small.push(JSON.stringify(row));
	}
	const head = `INSERT INTO ${table} (${columns.join(", ")})`;
	const select = columns.map((_, index) => `json_extract(item.value, '$[${index}]')`).join(", ");
	for (const parameter of arrays(small))
		await db.run(`${head} SELECT ${select} FROM json_each(?) AS item WHERE true ${conflict}`, parameter);
	const placeholder = `(${columns.map(() => "?").join(", ")})`;
	let count = 1;
	while (count * 2 * columns.length <= 100) count *= 2;
	for (let offset = 0; offset < large.length; offset += count) {
		while (count > large.length - offset) count /= 2;
		await db.run(
			`${head} VALUES ${Array(count).fill(placeholder).join(", ")} ${conflict}`,
			...large.slice(offset, offset + count).flat(),
		);
	}
}
