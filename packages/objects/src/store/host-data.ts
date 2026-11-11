import type { Context } from "../context/index.ts";
import type { Address } from "../contracts/index.ts";
import { kindOfKey } from "../contracts/host-kind.ts";
import { invalid } from "../data/internal.ts";
import { apply, type Op } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import { applyWrite } from "./applier.ts";
import { ARCHIVE_FORMAT, type ArchivePart, checkPart } from "./archive.ts";
import { createDocument, type DocumentRecord, listHostRecords, retireDocument } from "./engine.ts";
import { hostColumn, StoreExport } from "./export.ts";
import { each } from "./import.ts";
import { migrateRows } from "./import-migration.ts";
import { checkScalar, toSqlite } from "./rows.ts";
import { STORE_SCHEMA, TABLES } from "./schema.ts";
import { quote } from "./sql.ts";
import type { StagedWrite, Step } from "./step.ts";
import type { CommitFence, ObjectsStore, Store } from "./store.ts";
import type { TableDefinition } from "./table.ts";
import type { TableWrite } from "./table-writes.ts";
import { storedText } from "./text.ts";
import type { StoreWrite } from "./writes.ts";

export type HostImportOptions = { readonly address?: Address; readonly existing?: "refuse" | "replace" };
export type HostDataCounts = { readonly documents: number; readonly rows: number };
export type HostTable = {
	readonly write: Extract<TableWrite, { readonly kind: "table" }>;
	readonly column: string;
	readonly puts: Extract<TableWrite, { readonly kind: "put" }>[];
	readonly indexes: Extract<TableWrite, { readonly kind: "index" }>[];
};
type HostDocument = { readonly record: DocumentRecord; readonly value: JsonValue };
export type HostArchive = {
	readonly host: string;
	readonly tables: readonly HostTable[];
	readonly documents: readonly HostDocument[];
};
export type HostCommit = { readonly fence: CommitFence; readonly after: readonly StagedWrite[] };
export type HostImportPlan = {
	readonly target: string;
	readonly existing: "refuse" | "replace";
	readonly histories: ReadonlyMap<string, TableDefinition>;
};

export function exportHostData(store: Store, address: Address, context: Context): AsyncIterableIterator<ArchivePart> {
	const owned = store as ObjectsStore;
	owned.assertUsable();
	return new StoreExport(owned, context, { kind: "host", key: storedText(address.key, "exportHostData: address") });
}

export async function readHostArchive(
	parts: AsyncIterable<unknown> | Iterable<unknown>,
	context: Context,
): Promise<HostArchive> {
	const tables: HostTable[] = [],
		documents: HostDocument[] = [],
		addresses = new Set<string>();
	const state: { place: "manifest" | "tables" | "documents" | "ended" } = { place: "manifest" };
	let position = 0,
		host = "",
		writes = 0;
	let document: { record: DocumentRecord; seq: number; base: number | undefined; value: JsonValue } | undefined;
	const endDocument = (what: string): void => {
		if (document === undefined) return;
		if (document.base !== document.record.version)
			throw invalid("args", `${what}: record ${document.record.id} has no base at its version`);
		documents.push({ record: document.record, value: document.value });
		document = undefined;
	};
	await each(parts, context, async (value) => {
		const at = position++,
			part = checkPart(value, at, context),
			what = `importHostData: part ${at} (${part.kind})`;
		const refuse = (message: string): never => {
			throw invalid("args", `${what}: ${message}`);
		};
		if (state.place === "ended") refuse("after the end");
		if (state.place === "manifest" || part.kind === "manifest") {
			if (part.kind !== "manifest" || state.place !== "manifest") return refuse("the manifest comes first, once");
			if (part.format !== ARCHIVE_FORMAT) refuse(`format ${part.format} is not ${ARCHIVE_FORMAT}`);
			if (part.schema > STORE_SCHEMA) refuse(`schema ${part.schema} is newer than ${STORE_SCHEMA}`);
			if (part.host === undefined || storedText(part.host, what) !== part.host)
				return refuse("not a host's data archive (no host)");
			host = part.host;
			state.place = "tables";
			return;
		}
		if (part.kind === "end") {
			if (part.writes !== writes) refuse(`counts ${part.writes} writes, the archive has ${writes}`);
			endDocument(what);
			state.place = "ended";
			return;
		}
		writes++;
		switch (part.kind) {
			case "table": {
				if (state.place !== "tables") refuse("tables come before the documents");
				if (tables.some((table) => table.write.table === part.table)) refuse(`table ${part.table} occurs twice`);
				const column = hostColumn(part, kindOfKey(host));
				if (column === undefined || Object.values(part.columns).filter((cell) => cell.host !== undefined).length !== 1)
					return refuse(`table ${part.table} has no single host column of ${kindOfKey(host)}`);
				tables.push({ write: part, column, puts: [], indexes: [] });
				break;
			}
			case "put": {
				const table = tables.at(-1);
				if (state.place !== "tables" || table?.write.table !== part.table || table.indexes.length > 0)
					return refuse("a put follows its table's table write, before its indexes");
				if (part.row[table.column] !== host) refuse(`a row that does not belong to ${host}`);
				table.puts.push(part);
				break;
			}
			case "index": {
				const table = tables.at(-1);
				if (state.place !== "tables" || table?.write.table !== part.table)
					return refuse("an index follows its table's table write and puts");
				table.indexes.push(part);
				break;
			}
			case "document.create": {
				endDocument(what);
				state.place = "documents";
				const { record } = part;
				if (record.host !== host || record.key !== host) refuse(`a record that does not belong to ${host}`);
				if (record.history !== "none" || record.retiredAt !== undefined || record.meta !== undefined)
					refuse("not a live Objects record");
				for (const text of [record.owner, record.namespace, record.kind])
					if (storedText(text, what) !== text) refuse("an address is not well-formed text");
				const address = JSON.stringify([record.owner, record.namespace, record.kind]);
				if (addresses.has(address)) refuse("a second record at one address");
				addresses.add(address);
				document = { record, seq: 0, base: undefined, value: null };
				break;
			}
			case "document.revision": {
				if (document === undefined || document.record.id !== part.id || part.seq <= document.seq)
					return refuse("a revision follows its record's create, in seq order");
				const { content } = part;
				if (content.kind === "base") {
					document.base = content.version;
					document.value = content.value as JsonValue;
				} else if (content.version !== document.base) refuse("a delta without a base at its version");
				else {
					try {
						document.value = apply(document.value, content.ops as readonly Op[]);
					} catch (error) {
						refuse(`a delta that does not apply (${String(error)})`);
					}
				}
				document.seq = part.seq;
			}
		}
	});
	if (state.place !== "ended") throw invalid("args", "importHostData: the archive has no end part");
	return { host, tables, documents };
}

export function tablesToMigrate(store: Store, archive: HostArchive): string[] {
	return archive.tables.flatMap(({ write }) => {
		const recorded = (store as ObjectsStore).table(write.table);
		return recorded !== undefined && (recorded.version > write.version || write.state === "migrating")
			? [write.table]
			: [];
	});
}

export async function hostDataOwners(
	store: Store,
	key: string,
	archive: HostArchive | undefined,
	context: Context,
): Promise<Set<string>> {
	const owned = store as ObjectsStore,
		owners = new Set<string>();
	const ownerOf = (table: string) => table.slice(0, table.indexOf(":"));
	for (const record of owned.tables.values())
		if (hostColumn(record, kindOfKey(key)) !== undefined) owners.add(ownerOf(record.table));
	for (const table of archive?.tables ?? []) owners.add(ownerOf(table.write.table));
	for (const document of archive?.documents ?? []) owners.add(document.record.owner);
	const records = await owned.read(
		(db) => db.all<{ owner: string }>(`SELECT DISTINCT owner FROM ${TABLES.documents} WHERE host = ?`, key),
		context,
	);
	for (const record of records) owners.add(record.owner);
	return owners;
}

export async function importHostData(
	store: Store,
	archive: HostArchive,
	plan: HostImportPlan,
	commit: HostCommit,
	context: Context,
): Promise<HostDataCounts> {
	if (kindOfKey(plan.target) !== kindOfKey(archive.host))
		throw invalid("args", `importHostData: data of ${archive.host} cannot belong to ${plan.target}, another kind`);
	return operate(store, commit, context, async (step, writes) => {
		if (plan.existing === "replace") await remove(step, plan.target, writes);
		else if (await hasData(step, plan.target))
			throw invalid("args", `importHostData: ${plan.target} has data in this store (import with existing: "replace")`);
		let rows = 0;
		for (const table of archive.tables) rows += await importTable(step, table, archive.host, plan, writes, context);
		for (const { record, value } of archive.documents) {
			const { owner, namespace, kind, version, fingerprint } = record;
			const create = createDocument(
				{ owner, namespace, kind, key: plan.target, host: plan.target },
				{ version, fingerprint, value },
				JSON.stringify(value),
			);
			writes.push(...(await create.apply(step)));
		}
		return { documents: archive.documents.length, rows };
	});
}

export function deleteHostData(
	store: Store,
	key: string,
	commit: HostCommit,
	context: Context,
): Promise<HostDataCounts> {
	return operate(store, commit, context, (step, writes) => remove(step, key, writes));
}

async function operate(
	store: Store,
	commit: HostCommit,
	context: Context,
	apply: (step: Step, writes: StoreWrite[]) => Promise<HostDataCounts>,
): Promise<HostDataCounts> {
	let result: HostDataCounts = { documents: 0, rows: 0 };
	await (store as ObjectsStore).commit(
		[
			{
				order: "write",
				apply: async (step) => {
					const writes: StoreWrite[] = [];
					result = await apply(step, writes);
					return writes;
				},
			},
			...commit.after,
		],
		commit.fence,
		context,
	);
	return result;
}

async function importTable(
	step: Step,
	table: HostTable,
	source: string,
	plan: HostImportPlan,
	writes: StoreWrite[],
	context: Context,
): Promise<number> {
	const { write } = table,
		what = `importHostData: table ${write.table}`;
	const puts = table.puts.map((put) =>
		put.row[table.column] === plan.target ? put : { ...put, row: { ...put.row, [table.column]: plan.target } },
	);
	const recorded = step.table(write.table);
	let placed = puts;
	if (recorded === undefined) {
		for (const item of [write, ...table.indexes]) {
			await applyWrite(step, item, what);
			writes.push(item);
		}
	} else {
		if (recorded.state !== "ready") throw invalid("args", `${what}: migrating here; open its owner first`);
		if (write.version > recorded.version)
			throw invalid("args", `${what}: at version ${write.version} in the archive, newer than ${recorded.version} here`);
		if (write.version < recorded.version || write.state === "migrating") {
			const history = plan.histories.get(write.table);
			if (history === undefined)
				throw invalid("args", `${what}: at version ${write.version}, ${recorded.version} here; its owner is not live`);
			placed = migrateRows(write, puts, history, recorded, context);
		}
	}
	const record = step.table(write.table)!,
		column = hostColumn(record, kindOfKey(source));
	if (column === undefined) throw invalid("args", `${what}: no host column of ${kindOfKey(source)} here`);
	const query = `SELECT 1 AS found FROM ${quote(write.table)} WHERE ${record.key.map((name) => `${quote(name)} = ?`).join(" AND ")}`;
	for (const put of placed) {
		if (put.row[column] !== plan.target) throw invalid("args", `${what}: a row that does not belong to ${plan.target}`);
		const key: SqliteValue[] = record.key.map((name) =>
			toSqlite(checkScalar(record.columns[name]!.type as "str" | "int", put.row[name], `${what}: key`)),
		);
		if ((await step.get(query, ...key)) !== undefined)
			throw invalid("args", `${what}: a row with key ${JSON.stringify(key)} exists (of another address)`);
		await applyWrite(step, put, what);
		step.rows++;
		writes.push(put);
	}
	return placed.length;
}

function tables(step: Step, kind: string): [string, string][] {
	return step.records().flatMap((record) => {
		const column = hostColumn(record, kind);
		return column === undefined ? [] : [[record.table, column] as [string, string]];
	});
}

async function hasData(step: Step, key: string): Promise<boolean> {
	if ((await listHostRecords(step, key, 0, 1)).length > 0) return true;
	for (const [table, column] of tables(step, kindOfKey(key)))
		if (
			(await step.get(`SELECT 1 AS found FROM ${quote(table)} WHERE ${quote(column)} = ? LIMIT 1`, key)) !== undefined
		)
			return true;
	return false;
}

async function remove(step: Step, key: string, writes: StoreWrite[]): Promise<HostDataCounts> {
	const records = await listHostRecords(step, key, 0, Number.MAX_SAFE_INTEGER);
	for (const record of records) writes.push(...(await retireDocument(record.id, record.revision).apply(step)));
	let rows = 0;
	for (const [table, column] of tables(step, kindOfKey(key))) {
		const count = await step.runCounted(`DELETE FROM ${quote(table)} WHERE ${quote(column)} = ?`, key);
		step.rows += count;
		rows += count;
		writes.push({ kind: "deleteWhere", table, where: { eq: [column, key] }, count });
	}
	return { documents: records.length, rows };
}
