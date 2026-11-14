import type { Context } from "../context/index.ts";
import type { JsonValue } from "../json.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import { invalid } from "../data/internal.ts";
import type { Column, ColumnType, HostColumnOf } from "./columns.ts";
import { storedText } from "./text.ts";

export type Scalar = string | number | boolean;
export type StoredRow = { readonly [column: string]: Scalar | JsonValue };
export type EncodedRow = {
	readonly params: readonly SqliteValue[];
	readonly row: StoredRow;
	readonly columns: { readonly [column: string]: number };
	readonly id: string;
};
export type EncodedKey = {
	readonly params: readonly SqliteValue[];
	readonly key: { readonly [column: string]: Scalar };
	readonly id: string;
};
export const ROW_VERSION = "$v";
export function versionColumn(column: string): string {
	return `${column}$v`;
}
export function physicalColumns(columns: readonly { readonly name: string; readonly type: ColumnType }[]): string[] {
	return [
		...columns.map((column) => column.name),
		...columns.filter((column) => column.type === "json").map((column) => versionColumn(column.name)),
		ROW_VERSION,
	];
}
export function toSqlite(value: Scalar): string | number {
	return typeof value === "boolean" ? Number(value) : value;
}

export class RowCodec {
	readonly physical: readonly string[];
	readonly #columns: readonly Column[];
	readonly #keys: readonly Column[];
	readonly #json: readonly Extract<Column, { type: "json" }>[];
	readonly #host: HostColumnOf | undefined;
	readonly #names: ReadonlySet<string>;
	readonly #keyNames: ReadonlySet<string>;
	readonly #keyPositions: readonly number[];
	readonly #table: string;
	constructor(columns: readonly Column[], key: readonly string[], table: string) {
		this.#columns = columns;
		this.#keys = key.map((name) => columns.find((column) => column.name === name)!);
		this.#json = columns.filter((column) => column.type === "json");
		this.#host = columns.find((column): column is HostColumnOf => column.type === "str" && column.host !== undefined);
		this.#names = new Set(columns.map((column) => column.name));
		this.#keyNames = new Set(key);
		this.#keyPositions = key.map((name) => columns.findIndex((column) => column.name === name));
		this.#table = table;
		this.physical = physicalColumns(columns);
	}
	put(row: unknown, version: number): EncodedRow {
		const what = `${this.#table}: put`;
		const fields = closed(row, this.#names, what);
		const params: SqliteValue[] = [];
		const stored: Record<string, Scalar | JsonValue> = {};
		const versions: Record<string, number> = {};
		for (const column of this.#columns) {
			const input: unknown = Reflect.get(fields, column.name);
			const value = input === undefined && column.type !== "json" ? column.default : input;
			if (value === undefined) {
				if (!column.optional) throw invalid("args", `${what}: column "${column.name}" is missing`);
				params.push(null);
			} else {
				const encoded = encodeCell(column, value, `${what}: column "${column.name}"`);
				stored[column.name] = encoded.stored;
				params.push(encoded.param);
			}
		}
		for (const column of this.#json) {
			if (Object.hasOwn(stored, column.name)) {
				versions[column.name] = column.json.version;
				params.push(column.json.version);
			} else params.push(null);
		}
		params.push(version);
		return {
			params,
			row: stored,
			columns: versions,
			id: JSON.stringify(this.#keyPositions.map((position) => params[position])),
		};
	}
	key(key: unknown, operation: string): EncodedKey {
		const fields = closed(key, this.#keyNames, `${this.#table}: ${operation}: the key`);
		const params: SqliteValue[] = [];
		const stored: Record<string, Scalar> = {};
		for (const column of this.#keys) {
			const what = `${this.#table}: ${operation}: key column "${column.name}"`;
			const input: unknown = Reflect.get(fields, column.name);
			if (input === undefined) throw invalid("args", `${what} is missing`);
			if (column.type === "json") throw invalid("args", `${what}: a json(...) column has no scalar value`);
			const value =
				column.host === undefined ? toSqlite(checkScalar(column.type, input, what)) : column.host.key(input, what);
			params.push(value);
			stored[column.name] = value;
		}
		return { params, key: stored, id: JSON.stringify(params) };
	}
	decode(stored: Readonly<Record<string, SqliteValue>>, context: Context): Record<string, unknown> {
		const row: Record<string, unknown> = {};
		for (const column of this.#columns) {
			const value = stored[column.name];
			if (value === null || value === undefined) continue;
			if (column.type === "bool") row[column.name] = value === 1;
			else if (column.type === "str" && column.host !== undefined)
				row[column.name] = column.host.address(value as string);
			else if (column.type === "json")
				row[column.name] = column.json.read(
					value as string,
					stored[versionColumn(column.name)] as number,
					`${this.#table}.${column.name}`,
					context,
				);
			else row[column.name] = value;
		}
		return row;
	}
	stored<R extends Readonly<Record<string, unknown>>>(row: R): R {
		const column = this.#host,
			cell = column && row[column.name];
		if (!column || typeof cell !== "object" || cell === null) return row;
		return { ...row, [column.name]: (cell as { readonly key: string }).key };
	}
	addressed<R extends Readonly<Record<string, unknown>>>(row: R): R {
		const column = this.#host,
			cell = column && row[column.name];
		return column && typeof cell === "string" ? { ...row, [column.name]: column.host.address(cell) } : row;
	}
}

function closed(value: unknown, allowed: ReadonlySet<string>, what: string): object {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw invalid("args", `${what}: expected an object`);
	for (const name of Object.keys(value))
		if (!allowed.has(name)) throw invalid("args", `${what}: unknown column "${name}"`);
	return value;
}
export function encodeCell(
	column: Column,
	value: unknown,
	what: string,
): { readonly param: SqliteValue; readonly stored: Scalar | JsonValue } {
	if (column.type === "str" && column.host !== undefined) {
		const key = column.host.key(value, what);
		return { param: key, stored: key };
	}
	if (column.type !== "json") {
		const stored = checkScalar(column.type, value, what);
		return { param: toSqlite(stored), stored };
	}
	let encoded: string | undefined;
	try {
		encoded = JSON.stringify(value);
	} catch (error) {
		throw invalid("args", `${what}: not JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	if (encoded === undefined) throw invalid("args", `${what}: not JSON`);
	// Serialization is the boundary; same-host values remain immutable by convention.
	return { param: encoded, stored: value as JsonValue };
}
export function checkScalar(type: "str", value: unknown, what: string): string;
export function checkScalar(type: "int" | "num", value: unknown, what: string): number;
export function checkScalar(type: "bool", value: unknown, what: string): boolean;
export function checkScalar(type: "str" | "int" | "num" | "bool", value: unknown, what: string): Scalar;
export function checkScalar(type: "str" | "int" | "num" | "bool", value: unknown, what: string): Scalar {
	switch (type) {
		case "str":
			if (typeof value === "string") return storedText(value, what);
			break;
		case "int":
			if (typeof value === "number" && Number.isSafeInteger(value)) return value;
			break;
		case "num":
			if (typeof value === "number" && Number.isFinite(value)) return value;
			break;
		case "bool":
			if (typeof value === "boolean") return value;
			break;
	}
	throw invalid("args", `${what}: ${JSON.stringify(value) ?? String(value)} is not a ${type} value`);
}
