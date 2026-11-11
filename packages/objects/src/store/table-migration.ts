import { withoutAbortSignal, type Context } from "../context/index.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import type { Column } from "./columns.ts";
import type { SetNode, WhereNode } from "./expression.ts";
import { encodeCell, ROW_VERSION, type Scalar } from "./rows.ts";
import { TableSql } from "./sql.ts";
import type { StagedWrite } from "./step.ts";
import type { ObjectsStore, CommitFence } from "./store.ts";
import type { TableDefinition } from "./table.ts";
import { planTable, type DataStep, type TablePlan } from "./table-history.ts";
import {
	jsonVersions,
	recordedVersions,
	stageEdit,
	stageIndex,
	stageTable,
	stageUpdate,
	stageUpdateWhere,
} from "./table-writes.ts";

export type DeclaredTable = {
	readonly definition: TableDefinition;
	readonly table: string;
};
export const MIGRATION_CHUNK = 100;
export async function prepareTables(
	tables: readonly DeclaredTable[],
	store: ObjectsStore,
	fence: CommitFence,
	what: string,
	context: Context,
): Promise<void> {
	const create: StagedWrite[] = [],
		upgrades: {
			table: string;
			plan: Extract<TablePlan, { readonly kind: "migrate" }>;
		}[] = [];
	const commit = async (writes: readonly StagedWrite[]): Promise<void> => {
		await store.commit(writes, fence, withoutAbortSignal(context));
	};
	for (const { definition, table } of tables) {
		const plan = planTable(definition, store.table(table), `${what}: table "${definition.name}"`);
		if (plan.kind === "create") {
			create.push(record(table, definition, definition, "ready"));
			for (const [name, columns] of definition.indexes)
				create.push(stageIndex({ kind: "index", table, name, columns }));
		} else if (plan.kind === "migrate") upgrades.push({ table, plan });
	}
	if (create.length) await commit(create);
	for (const { table, plan } of upgrades)
		for (const [i, definition] of plan.versions.entries()) {
			const withdraw = store.announceTable(table, definition.version);
			try {
				const migration = definition.evolution!.migration,
					edits = (items: typeof migration.before): StagedWrite[] =>
						items.map((edit) => stageEdit(table, definition.version, edit));
				const finish = [...edits(migration.after), record(table, definition, definition, "ready")];
				const { step } = migration;
				if (!step) {
					await commit([...edits(migration.before), ...finish]);
					continue;
				}
				if (i > 0 || plan.first === "begin")
					await commit([...edits(migration.before), record(table, step.table, definition, "migrating")]);
				const sql = new TableSql(table, step.table.columns, step.table.rows.physical, step.table.key);
				const below: WhereNode = { lt: [ROW_VERSION, definition.version] };
				if (step.kind === "update") {
					const where: WhereNode = step.where === undefined ? below : { and: [step.where, below] },
						versions = jsonVersions(step.table, step.set);
					const statement = sql.updateWhere(where, { ...step.set, [ROW_VERSION]: definition.version }, versions);
					await commit([
						stageUpdateWhere(
							statement,
							table,
							where,
							step.set,
							recordedVersions(step.set, versions),
							definition.version,
						),
						...finish,
					]);
				} else {
					let after: SqliteValue[] | undefined, channel: InstanceType<typeof MessageChannel> | undefined;
					try {
						for (;;) {
							const statement = sql.select(
								below,
								{ columns: step.table.key, direction: "asc" },
								after,
								MIGRATION_CHUNK + 1,
							);
							const rows = await store.read(
								(executor) => executor.all<Record<string, SqliteValue>>(statement.sql, ...statement.params),
								context,
							);
							const final = rows.length <= MIGRATION_CHUNK;
							if (!final) rows.length = MIGRATION_CHUNK;
							const writes = rows.map((row) => patchRow(step, row, definition.version, sql, table, context));
							await commit(final ? [...writes, ...finish] : writes);
							if (final) break;
							after = step.table.key.map((name) => rows.at(-1)![name]!);
							await new Promise<void>((resolve) => {
								const immediate = globalThis.setImmediate;
								if (typeof immediate === "function") immediate(resolve);
								else {
									channel ??= new MessageChannel();
									channel.port1.addEventListener("message", () => resolve(), {
										once: true,
									});
									channel.port1.start();
									channel.port2.postMessage(null);
								}
							});
							context.abortSignal?.throwIfAborted();
						}
					} finally {
						channel?.port1.close();
					}
				}
			} finally {
				withdraw();
			}
		}
}
function record(
	table: string,
	columns: TableDefinition,
	version: TableDefinition,
	state: "ready" | "migrating",
): StagedWrite {
	return stageTable({
		kind: "table",
		table,
		version: version.version,
		state,
		columns: columns.record,
		key: columns.key,
		fingerprint: version.fingerprint,
	});
}
function patchRow(
	step: Extract<DataStep, { readonly kind: "rows" }>,
	stored: Readonly<Record<string, SqliteValue>>,
	version: number,
	sql: TableSql,
	table: string,
	context: Context,
): StagedWrite {
	const definition = step.table,
		set = patchSet(step, definition.rows.decode(stored, context), version);
	const versions = jsonVersions(definition, set),
		key = Object.fromEntries(definition.key.map((name) => [name, stored[name] as Scalar]));
	return stageUpdate(
		sql.update(
			{ ...set, [ROW_VERSION]: version },
			definition.key.map((name) => stored[name]!),
			versions,
		),
		table,
		key,
		set,
		recordedVersions(set, versions),
		version,
	);
}
export function patchSet(
	step: Extract<DataStep, { readonly kind: "rows" }>,
	row: Readonly<Record<string, unknown>>,
	version: number,
): SetNode {
	const definition = step.table,
		patch = step.patch(row),
		label = `${definition.name} version ${version}: rows`;
	if (!patch || typeof patch !== "object" || Array.isArray(patch))
		throw new Error(`${label}: expected an object of column values`);
	const set: Record<string, SetNode[string]> = {};
	for (const [name, value] of Object.entries(patch)) {
		const column = definition.byName.get(name);
		if (!column) throw new Error(`${label}: no column "${name}"`);
		if (definition.key.includes(name)) throw new Error(`${label}: key column "${name}" cannot change`);
		set[name] = cell(column, value, `${label}: column "${name}"`);
	}
	return set;
}
function cell(column: Column, value: unknown, what: string): SetNode[string] {
	if (value === undefined) {
		if (!column.optional) throw new Error(`${what} is not opt(...) and cannot be cleared`);
		return null;
	}
	const encoded = encodeCell(column, value, what);
	return column.type === "json" ? { json: encoded.stored } : (encoded.stored as Scalar);
}
