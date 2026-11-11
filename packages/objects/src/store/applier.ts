import type { SqliteValue } from "../sqlite/index.ts";
import { checkName } from "../contracts/names.ts";
import { invalid } from "../data/internal.ts";
import type { TableRecord } from "./catalog.ts";
import { COLUMN_NAME, type ColumnRecord } from "./columns.ts";
import {
	insertDocument,
	insertRevision,
	readDocument,
	retireRecord,
	writeContent,
	type DocumentRecord,
} from "./engine.ts";
import type { ExprNode, SetNode, WhereNode } from "./expression.ts";
import { checkScalar, toSqlite, versionColumn, ROW_VERSION } from "./rows.ts";
import { recordedPut, TableSql, type Statement } from "./sql.ts";
import type { Step } from "./step.ts";
import { INDEX_NAME } from "./table.ts";
import {
	applyAlter,
	applyDropIndex,
	applyIndex,
	applyTable,
	type TableWrite,
	type StoredKey,
} from "./table-writes.ts";
import type { StoreWrite } from "./writes.ts";

export class Diverged extends Error {}
type Updating = Extract<
	TableWrite,
	{ readonly kind: "update" | "updateWhere" }
>;
export async function applyWrite(
	step: Step,
	write: StoreWrite,
	what: string,
): Promise<void> {
	const refused = (message: string): never => {
		throw invalid("args", `${what}: ${message}`);
	};
	switch (write.kind) {
		case "table": {
			const parts = write.table.split(":");
			if (parts.length !== 2)
				refused(`table ${JSON.stringify(write.table)}: not owner:table`);
			try {
				for (const part of parts) checkName(part, `${what}: table name part`);
			} catch (error) {
				throw invalid(
					"args",
					error instanceof Error ? error.message : String(error),
				);
			}
			const seen = new Set<string>();
			if (Object.values(write.columns).filter((column) => column.host !== undefined).length > 1)
				refused("more than one host column");
			for (const [name, column] of Object.entries(write.columns)) {
				const at = `${what}: column ${JSON.stringify(name)}`;
				if (!COLUMN_NAME.test(name) || seen.has(name.toLowerCase()))
					throw invalid("args", `${at}: not a column name`);
				seen.add(name.toLowerCase());
				checkColumn(column, at);
			}
			if (!write.key.length) refused("the key has no column");
			checkOrder(write.columns, write.key, `${what}: the key`);
			await applyTable(step, write);
			return;
		}
		case "index": {
			const record = table(step, write.table, what);
			if (
				!INDEX_NAME.test(write.name) ||
				Object.hasOwn(record.indexes, write.name)
			)
				refused(`index ${JSON.stringify(write.name)}: not a new index name`);
			checkOrder(record.columns, write.columns, `${what}: index ${write.name}`);
			await applyIndex(step, write);
			return;
		}
		case "dropIndex":
			if (!Object.hasOwn(table(step, write.table, what).indexes, write.name))
				refused(`no index ${JSON.stringify(write.name)}`);
			await applyDropIndex(step, write);
			return;
		case "alter":
			checkAlter(table(step, write.table, what), write, what);
			await applyAlter(step, write);
			return;
		case "put": {
			const record = table(step, write.table, what),
				statement = recordedPut(write.table, record.columns);
			await step.run(
				statement.sql,
				...putValues(record, write, statement.physical, what),
			);
			return;
		}
		case "document.create":
			await insertDocument(
				step,
				write.record,
				write.base === undefined ? undefined : json(write.base.value, what),
			);
			return;
		case "document.revision":
			await insertRevision(
				step,
				write.id,
				write.seq,
				write.content.kind,
				write.content.version,
				json(
					write.content.kind === "base"
						? write.content.value
						: write.content.ops,
					what,
				),
			);
			return;
		case "document.change": {
			const record = await live(step, write.id, write.revision, what),
				{ content } = write;
			await writeContent(
				step,
				write.id,
				record.history,
				write.revision,
				content,
				json(content.kind === "base" ? content.value : content.ops, what),
			);
			return;
		}
		case "document.retire":
			await retireRecord(
				step,
				await live(step, write.id, write.revision, what),
			);
			return;
		default: {
			const record = table(step, write.table, what),
				columns = Object.entries(record.columns).map(([name, column]) => ({
					name,
					type: column.type,
				}));
			const sql = new TableSql(record.table, columns, [], record.key);
			let statement: Statement;
			if (write.kind === "update")
				statement = sql.update(
					setOf(record, write, what),
					keyValues(record, write.key, what),
					versions(record, write, what),
				);
			else if (write.kind === "delete")
				statement = {
					sql: sql.delete,
					params: keyValues(record, write.key, what),
				};
			else {
				checkWhere(record, write.where, what);
				statement =
					write.kind === "updateWhere"
						? sql.updateWhere(
								write.where,
								setOf(record, write, what),
								versions(record, write, what),
							)
						: sql.deleteWhere(write.where);
			}
			const changed = await step.runCounted(statement.sql, ...statement.params);
			if (changed !== write.count)
				throw new Diverged(
					`${what}: changed ${changed} rows, recorded ${write.count}`,
				);
		}
	}
}
async function live(
	step: Step,
	id: number,
	revision: number,
	what: string,
): Promise<DocumentRecord> {
	const record = await readDocument(step, id);
	if (!record || record.retiredAt !== undefined || record.revision !== revision)
		throw new Diverged(
			`${what}: document ${id} is not live at revision ${revision}`,
		);
	return record;
}
function table(step: Step, name: string, what: string): TableRecord {
	const record = step.table(name);
	if (!record)
		throw invalid(
			"args",
			`${what}: table ${JSON.stringify(name)} is not recorded`,
		);
	return record;
}
function json(value: unknown, what: string): string {
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch (error) {
		throw invalid("args", `${what}: not JSON (${String(error)})`);
	}
	if (text === undefined) throw invalid("args", `${what}: not JSON`);
	return text;
}
function checkColumn(column: ColumnRecord, what: string): void {
	if (column.host !== undefined) {
		if (column.type !== "str" || column.optional === true || column.default !== undefined)
			throw invalid("args", `${what}: a host column is a non-opt str column without a default`);
		try {
			checkName(column.host, `${what}: host kind`);
		} catch (error) {
			throw invalid("args", error instanceof Error ? error.message : String(error));
		}
	}
	const isJson = column.type === "json";
	if (
		isJson !== (column.version !== undefined) ||
		isJson !== (column.fingerprint !== undefined)
	)
		throw invalid(
			"args",
			`${what}: a json(...) column has a version and a fingerprint, no other column has`,
		);
	if (column.default === undefined) return;
	if (isJson || column.optional)
		throw invalid(
			"args",
			`${what}: only a non-opt scalar column has a default`,
		);
	checkScalar(column.type, column.default, `${what}: the default`);
}
function checkOrder(
	columns: Readonly<Record<string, ColumnRecord>>,
	names: readonly string[],
	what: string,
): void {
	if (new Set(names).size !== names.length)
		throw invalid("args", `${what}: a column occurs twice`);
	for (const name of names) {
		const column = Object.hasOwn(columns, name) ? columns[name] : undefined;
		if (
			!column ||
			column.optional ||
			(column.type !== "str" && column.type !== "int")
		)
			throw invalid(
				"args",
				`${what}: ${JSON.stringify(name)} is not a non-opt str or int column`,
			);
	}
}
function checkAlter(
	record: TableRecord,
	write: Extract<TableWrite, { readonly kind: "alter" }>,
	what: string,
): void {
	if (write.version !== record.version && write.version !== record.version + 1)
		throw invalid(
			"args",
			`${what}: an edit of version ${write.version} on version ${record.version}`,
		);
	const has = (name: string): boolean => Object.hasOwn(record.columns, name);
	const fresh = (name: string): boolean =>
		COLUMN_NAME.test(name) &&
		!Object.keys(record.columns).some(
			(present) => present.toLowerCase() === name.toLowerCase(),
		);
	const { edit } = write;
	let valid: boolean;
	switch (edit.kind) {
		case "rename":
			valid = has(edit.from) && fresh(edit.to);
			break;
		case "add":
			valid =
				fresh(edit.name) &&
				(edit.column.optional === true || edit.column.default !== undefined);
			break;
		case "drop":
			valid =
				has(edit.name) &&
				!record.key.includes(edit.name) &&
				!Object.values(record.indexes).some((on) => on.includes(edit.name));
			break;
		case "json":
			valid =
				has(edit.name) &&
				record.columns[edit.name]!.type === "json" &&
				edit.column.type === "json";
			break;
	}
	if (!valid)
		throw invalid(
			"args",
			`${what}: an ${edit.kind} edit the table cannot take`,
		);
	if (edit.kind === "add" || edit.kind === "json")
		checkColumn(edit.column, `${what}: column ${JSON.stringify(edit.name)}`);
}
function keyValues(
	record: TableRecord,
	key: StoredKey,
	what: string,
): SqliteValue[] {
	if (Object.keys(key).length !== record.key.length)
		throw invalid("args", `${what}: not a key of ${record.table}`);
	return record.key.map((name) => {
		if (!Object.hasOwn(key, name))
			throw invalid(
				"args",
				`${what}: key column ${JSON.stringify(name)} is missing`,
			);
		const column = record.columns[name]!;
		return toSqlite(
			checkScalar(
				column.type === "json" ? "str" : column.type,
				key[name],
				`${what}: key`,
			),
		);
	});
}
function setOf(record: TableRecord, write: Updating, what: string): SetNode {
	if (
		typeof write.set !== "object" ||
		write.set === null ||
		!Object.keys(write.set).length
	)
		throw invalid("args", `${what}: an empty or malformed set`);
	for (const [name, node] of Object.entries(write.set)) {
		if (!Object.hasOwn(record.columns, name) || record.key.includes(name))
			throw invalid(
				"args",
				`${what}: set writes ${JSON.stringify(name)}, no non-key column`,
			);
		checkExpr(record, node, what);
	}
	return write.version === undefined
		? write.set
		: { ...write.set, [ROW_VERSION]: write.version };
}
function versions(
	record: TableRecord,
	write: Updating,
	what: string,
): Map<string, number> {
	const result = new Map<string, number>();
	for (const [name, column] of Object.entries(record.columns))
		if (column.type === "json" && Object.hasOwn(write.set, name)) {
			const version = write.columns[name] ?? column.version!;
			if (
				!Number.isSafeInteger(version) ||
				version < 1 ||
				version > column.version!
			)
				throw invalid(
					"args",
					`${what}: no readable version for ${JSON.stringify(name)}`,
				);
			result.set(name, version);
		}
	return result;
}
function scalar(value: unknown): boolean {
	return (
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}
function checkWhere(
	record: TableRecord,
	node: unknown,
	what: string,
): asserts node is WhereNode {
	const refuse = (): never => {
		throw invalid("args", `${what}: a malformed condition`);
	};
	if (!node || typeof node !== "object" || Object.keys(node).length !== 1)
		return refuse();
	const [op, value] = Object.entries(node)[0]!;
	const column = (name: unknown): void => {
		if (
			name !== ROW_VERSION &&
			(typeof name !== "string" ||
				record.columns[name] === undefined ||
				record.columns[name]!.type === "json")
		)
			refuse();
	};
	if (op === "and" || op === "or") {
		if (!Array.isArray(value)) return refuse();
		for (const part of value) checkWhere(record, part, what);
		return;
	}
	if (op === "not") return checkWhere(record, value, what);
	if (op === "isNull") return column(value);
	if (
		!["eq", "ne", "lt", "lte", "gt", "gte", "prefix", "inArray"].includes(op) ||
		!Array.isArray(value) ||
		value.length !== 2
	)
		return refuse();
	column(value[0]);
	const values: unknown = op === "inArray" ? value[1] : [value[1]];
	if (!Array.isArray(values)) return refuse();
	if (
		values.some(
			(item: unknown) =>
				!scalar(item) || (op === "prefix" && typeof item !== "string"),
		)
	)
		refuse();
}
function checkExpr(
	record: TableRecord,
	node: unknown,
	what: string,
): asserts node is ExprNode {
	if (node === null || scalar(node)) return;
	const refuse = (): never => {
		throw invalid("args", `${what}: a malformed expression`);
	};
	if (typeof node !== "object" || Object.keys(node).length !== 1)
		return refuse();
	const [op, value] = Object.entries(node)[0]!;
	if (op === "json") return;
	if (op === "col") {
		if (typeof value !== "string" || !Object.hasOwn(record.columns, value))
			refuse();
		return;
	}
	if (!Array.isArray(value)) return refuse();
	if (
		["add", "sub", "max", "min", "concat", "coalesce"].includes(op) &&
		value.length === 2
	) {
		for (const part of value) checkExpr(record, part, what);
		return;
	}
	if (op === "replacePrefix" && value.length === 3) {
		checkExpr(record, value[0], what);
		if (typeof value[1] !== "string" || typeof value[2] !== "string") refuse();
		return;
	}
	if (op === "when" && value.length === 3) {
		checkWhere(record, value[0], what);
		checkExpr(record, value[1], what);
		checkExpr(record, value[2], what);
		return;
	}
	refuse();
}
function putValues(
	record: TableRecord,
	write: Extract<TableWrite, { readonly kind: "put" }>,
	physical: readonly string[],
	what: string,
): SqliteValue[] {
	for (const name of Object.keys(write.row))
		if (!Object.hasOwn(record.columns, name))
			throw invalid("args", `${what}: unknown column ${JSON.stringify(name)}`);
	for (const name of Object.keys(write.columns))
		if (
			record.columns[name]?.type !== "json" ||
			!Object.hasOwn(write.row, name)
		)
			throw invalid(
				"args",
				`${what}: a version for ${JSON.stringify(name)}, which is no json(...) cell of the row`,
			);
	if (write.version > record.version)
		throw invalid(
			"args",
			`${what}: version ${write.version} is newer than the table's version ${record.version}`,
		);
	const values = new Map<string, SqliteValue>();
	for (const [name, column] of Object.entries(record.columns)) {
		const value = write.row[name],
			label = `${what}: column ${JSON.stringify(name)}`;
		if (
			column.type === "json"
				? !Object.hasOwn(write.row, name)
				: value === undefined
		) {
			if (!column.optional) throw invalid("args", `${label} is missing`);
			values.set(name, null);
		} else if (column.type !== "json")
			values.set(name, toSqlite(checkScalar(column.type, value, label)));
		else {
			const version = write.columns[name];
			if (version === undefined || version > column.version!)
				throw invalid("args", `${label}: no readable version`);
			values.set(name, json(value, label));
			values.set(versionColumn(name), version);
		}
	}
	return physical.map((name) =>
		name === ROW_VERSION ? write.version : (values.get(name) ?? null),
	);
}
