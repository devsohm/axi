import type { TableRecord } from "./catalog.ts";
import type { ColumnRecord } from "./columns.ts";
import type { SetNode, WhereNode } from "./expression.ts";
import {
	versionColumn,
	type EncodedRow,
	type Scalar,
	type StoredRow,
} from "./rows.ts";
import {
	columnSql,
	createIndexSql,
	createTableSql,
	dropIndexSql,
	quote,
	type Statement,
} from "./sql.ts";
import type { StagedWrite, Step } from "./step.ts";
import type { TableDefinition } from "./table.ts";
import type { AlterEdit, TableEdit } from "./table-history.ts";

export type StoredKey = Readonly<Record<string, Scalar>>;
export type ColumnVersions = Readonly<Record<string, number>>;
export type TableWrite =
	| {
			readonly kind: "table";
			readonly table: string;
			readonly version: number;
			readonly state: "ready" | "migrating";
			readonly columns: Readonly<Record<string, ColumnRecord>>;
			readonly key: readonly string[];
			readonly fingerprint: string;
	  }
	| {
			readonly kind: "index";
			readonly table: string;
			readonly name: string;
			readonly columns: readonly string[];
	  }
	| {
			readonly kind: "dropIndex";
			readonly table: string;
			readonly name: string;
	  }
	| {
			readonly kind: "alter";
			readonly table: string;
			readonly version: number;
			readonly edit: AlterEdit;
	  }
	| {
			readonly kind: "put";
			readonly table: string;
			readonly row: StoredRow;
			readonly version: number;
			readonly columns: ColumnVersions;
	  }
	| {
			readonly kind: "update";
			readonly table: string;
			readonly key: StoredKey;
			readonly set: SetNode;
			readonly columns: ColumnVersions;
			readonly count: number;
			readonly version?: number;
	  }
	| {
			readonly kind: "delete";
			readonly table: string;
			readonly key: StoredKey;
			readonly count: number;
	  }
	| {
			readonly kind: "updateWhere";
			readonly table: string;
			readonly where: WhereNode;
			readonly set: SetNode;
			readonly columns: ColumnVersions;
			readonly count: number;
			readonly version?: number;
	  }
	| {
			readonly kind: "deleteWhere";
			readonly table: string;
			readonly where: WhereNode;
			readonly count: number;
	  };
export type TableDefinitionWrite = Extract<
	TableWrite,
	{ readonly kind: "table" }
>;
export function jsonVersions(
	definition: TableDefinition,
	set: SetNode,
): ReadonlyMap<string, number> {
	const result = new Map<string, number>();
	for (const name of Object.keys(set)) {
		const column = definition.byName.get(name)!;
		if (column.type === "json") result.set(name, column.json.version);
	}
	return result;
}
export function recordedVersions(
	set: SetNode,
	versions: ReadonlyMap<string, number>,
): ColumnVersions {
	return Object.fromEntries(
		[...versions].filter(([name]) => set[name] !== null),
	);
}
export function stageTable(write: TableDefinitionWrite): StagedWrite {
	return {
		order: "write",
		apply: async (step) => [await applyTable(step, write)],
	};
}
export function stageIndex(
	write: Extract<TableWrite, { readonly kind: "index" }>,
): StagedWrite {
	return {
		order: "write",
		apply: async (step) => [await applyIndex(step, write)],
	};
}
export function stageEdit(
	table: string,
	version: number,
	edit: TableEdit,
): StagedWrite {
	if (edit.kind === "index")
		return stageIndex({
			kind: "index",
			table,
			name: edit.name,
			columns: edit.columns,
		});
	if (edit.kind === "dropIndex")
		return {
			order: "write",
			apply: async (step) => [
				await applyDropIndex(step, {
					kind: "dropIndex",
					table,
					name: edit.name,
				}),
			],
		};
	return {
		order: "write",
		apply: async (step) => [
			await applyAlter(step, { kind: "alter", table, version, edit }),
		],
	};
}
export function stagePut(
	sql: string,
	table: string,
	row: EncodedRow,
	version: number,
): StagedWrite {
	return {
		order: "write",
		async apply(step) {
			await step.run(sql, ...row.params);
			step.rows += 1;
			return [
				{ kind: "put", table, row: row.row, version, columns: row.columns },
			];
		},
	};
}
function counted(
	statement: Statement,
	record: (count: number) => TableWrite,
): StagedWrite {
	return {
		order: "write",
		async apply(step) {
			const count = await step.runCounted(statement.sql, ...statement.params);
			step.rows += count;
			return [record(count)];
		},
	};
}
export function stageUpdate(
	statement: Statement,
	table: string,
	key: StoredKey,
	set: SetNode,
	columns: ColumnVersions,
	version?: number,
): StagedWrite {
	return counted(statement, (count) => ({
		kind: "update",
		table,
		key,
		set,
		columns,
		count,
		...(version === undefined ? {} : { version }),
	}));
}
export function stageDelete(
	statement: Statement,
	table: string,
	key: StoredKey,
): StagedWrite {
	return counted(statement, (count) => ({ kind: "delete", table, key, count }));
}
export function stageUpdateWhere(
	statement: Statement,
	table: string,
	where: WhereNode,
	set: SetNode,
	columns: ColumnVersions,
	version?: number,
): StagedWrite {
	return counted(statement, (count) => ({
		kind: "updateWhere",
		table,
		where,
		set,
		columns,
		count,
		...(version === undefined ? {} : { version }),
	}));
}
export function stageDeleteWhere(
	statement: Statement,
	table: string,
	where: WhereNode,
): StagedWrite {
	return counted(statement, (count) => ({
		kind: "deleteWhere",
		table,
		where,
		count,
	}));
}
function recorded(step: Step, table: string): TableRecord {
	const record = step.table(table);
	if (!record) throw new Error(`table ${table}: not in the store`);
	return record;
}
export async function applyTable(
	step: Step,
	write: TableDefinitionWrite,
): Promise<TableWrite> {
	const previous = step.table(write.table);
	if (!previous)
		await step.run(createTableSql(write.table, write.columns, write.key));
	const { kind: _kind, ...definition } = write;
	step.tables.set(write.table, {
		...definition,
		indexes: previous?.indexes ?? {},
	});
	return write;
}
export async function applyIndex(
	step: Step,
	write: Extract<TableWrite, { readonly kind: "index" }>,
): Promise<TableWrite> {
	const old = recorded(step, write.table);
	await step.run(
		createIndexSql(write.table, write.name, write.columns, old.key),
	);
	step.tables.set(write.table, {
		...old,
		indexes: { ...old.indexes, [write.name]: write.columns },
	});
	return write;
}
export async function applyDropIndex(
	step: Step,
	write: Extract<TableWrite, { readonly kind: "dropIndex" }>,
): Promise<TableWrite> {
	const old = recorded(step, write.table),
		indexes = { ...old.indexes };
	await step.run(dropIndexSql(write.table, write.name));
	delete indexes[write.name];
	step.tables.set(write.table, { ...old, indexes });
	return write;
}
export async function applyAlter(
	step: Step,
	write: Extract<TableWrite, { readonly kind: "alter" }>,
): Promise<TableWrite> {
	const old = recorded(step, write.table),
		{ edit } = write,
		prefix = `ALTER TABLE ${quote(write.table)}`;
	let next: TableRecord;
	if (edit.kind === "rename") {
		const rename = (name: string): string =>
			name === edit.from ? edit.to : name;
		await step.run(
			`${prefix} RENAME COLUMN ${quote(edit.from)} TO ${quote(edit.to)}`,
		);
		if (old.columns[edit.from]?.type === "json")
			await step.run(
				`${prefix} RENAME COLUMN ${quote(versionColumn(edit.from))} TO ${quote(versionColumn(edit.to))}`,
			);
		next = {
			...old,
			columns: Object.fromEntries(
				Object.entries(old.columns).map(([name, column]) => [
					rename(name),
					column,
				]),
			),
			key: old.key.map(rename),
			indexes: Object.fromEntries(
				Object.entries(old.indexes).map(([name, on]) => [name, on.map(rename)]),
			),
		};
	} else if (edit.kind === "drop") {
		await step.run(`${prefix} DROP COLUMN ${quote(edit.name)}`);
		if (old.columns[edit.name]?.type === "json")
			await step.run(
				`${prefix} DROP COLUMN ${quote(versionColumn(edit.name))}`,
			);
		const columns = { ...old.columns };
		delete columns[edit.name];
		next = { ...old, columns };
	} else {
		if (edit.kind === "add")
			for (const column of columnSql(edit.name, edit.column))
				await step.run(`${prefix} ADD COLUMN ${column}`);
		next = { ...old, columns: { ...old.columns, [edit.name]: edit.column } };
	}
	step.tables.set(write.table, next);
	return write;
}
