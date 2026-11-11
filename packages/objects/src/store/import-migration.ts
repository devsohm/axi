import type { Context } from "../context/index.ts";
import { invalid } from "../data/internal.ts";
import type { JsonValue } from "../json.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import type { TableRecord } from "./catalog.ts";
import { applySet, matches } from "./evaluate.ts";
import { ROW_VERSION, versionColumn } from "./rows.ts";
import type { TableDefinition } from "./table.ts";
import { historyOf, type DataStep, type TableEdit } from "./table-history.ts";
import { patchSet } from "./table-migration.ts";
import type { TableWrite } from "./table-writes.ts";

type Put = Extract<TableWrite, { readonly kind: "put" }>;
type Row = { value: Record<string, JsonValue | undefined>; columns: Record<string, number>; version: number };

export function migrateRows(
	write: Extract<TableWrite, { readonly kind: "table" }>,
	puts: readonly Put[],
	history: TableDefinition,
	recorded: TableRecord,
	context: Context,
): Put[] {
	const versions = historyOf(history),
		from = versions.find((item) => item.version === write.version);
	if (from === undefined || !versions.some((item) => item.version === recorded.version))
		throw invalid(
			"args",
			`importHostData: table ${write.table}: version ${write.version} or ${recorded.version} is not in its owner's history`,
		);
	if (write.state === "migrating" && from.evolution?.migration.step === undefined)
		throw invalid(
			"args",
			`importHostData: table ${write.table}: version ${write.version} exported migrating has no data step to resume`,
		);
	const later = versions.filter((item) => item.version > write.version && item.version <= recorded.version);
	return puts.map((put) => {
		const row: Row = { value: { ...put.row }, columns: { ...put.columns }, version: put.version };
		if (write.state === "migrating") {
			const migration = from.evolution!.migration;
			stepRow(row, from.version, migration.step!, context);
			for (const edit of migration.after) editRow(row, edit);
		}
		for (const version of later) {
			const migration = version.evolution!.migration;
			for (const edit of migration.before) editRow(row, edit);
			if (migration.step) stepRow(row, version.version, migration.step, context);
			for (const edit of migration.after) editRow(row, edit);
		}
		return { ...put, row: row.value as Put["row"], version: row.version, columns: row.columns };
	});
}

function editRow(row: Row, edit: TableEdit): void {
	switch (edit.kind) {
		case "rename":
			if (Object.hasOwn(row.value, edit.from)) row.value = { ...row.value, [edit.to]: row.value[edit.from]! };
			delete row.value[edit.from];
			if (Object.hasOwn(row.columns, edit.from)) row.columns[edit.to] = row.columns[edit.from]!;
			delete row.columns[edit.from];
			break;
		case "add":
			if (edit.column.default !== undefined) row.value = { ...row.value, [edit.name]: edit.column.default };
			break;
		case "drop":
			delete row.value[edit.name];
			delete row.columns[edit.name];
			break;
	}
}

function stepRow(row: Row, version: number, step: DataStep, context: Context): void {
	if (row.version >= version) return;
	const { table } = step;
	if (step.kind === "update" && step.where !== undefined && !matches(step.where, row.value)) return;
	const set =
		step.kind === "update" ? step.set : patchSet(step, table.rows.decode(sqliteRow(row, table), context), version);
	row.value = applySet(set, row.value, table.name);
	for (const [name, value] of Object.entries(set)) {
		const column = table.byName.get(name)!;
		if (column.type !== "json") continue;
		if (value === null) delete row.columns[name];
		else row.columns[name] = column.json.version;
	}
	row.version = version;
}

function sqliteRow(row: Row, table: TableDefinition): Record<string, SqliteValue> {
	const stored: Record<string, SqliteValue> = { [ROW_VERSION]: row.version };
	for (const column of table.columns) {
		const value = row.value[column.name];
		if (value === undefined) stored[column.name] = null;
		else if (column.type === "json") {
			stored[column.name] = JSON.stringify(value);
			stored[versionColumn(column.name)] = row.columns[column.name] ?? null;
		} else if (column.type === "bool") stored[column.name] = value === true ? 1 : 0;
		else stored[column.name] = value as string | number;
	}
	return stored;
}
