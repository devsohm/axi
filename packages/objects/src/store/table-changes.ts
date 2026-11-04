import type { Context } from "../context/index.ts";
import { invalid } from "../data/internal.ts";
import { applySet, type EvaluatedRow } from "./evaluate.ts";
import {
	compileSet,
	compileWhere,
	type SetNode,
	type WhereNode,
} from "./expression.ts";
import type { StagedWrite } from "./step.ts";
import type { TableHandle } from "./table-handle.ts";
import {
	jsonVersions,
	recordedVersions,
	stageDelete,
	stageDeleteWhere,
	stagePut,
	stageUpdate,
	stageUpdateWhere,
} from "./table-writes.ts";

type Change =
	| { readonly kind: "put"; readonly row: EvaluatedRow }
	| { readonly kind: "update"; readonly set: SetNode }
	| { readonly kind: "delete" };
export class TableChanges {
	readonly handle: TableHandle;
	readonly #staged: StagedWrite[];
	readonly #keys = new Map<string, Change[]>();
	#bulk = false;
	constructor(handle: TableHandle, staged: StagedWrite[]) {
		this.handle = handle;
		this.#staged = staged;
	}
	put(row: unknown): void {
		const { definition, sql } = this.handle,
			encoded = definition.rows.put(row, definition.version);
		this.#staged.push(
			stagePut(sql.put, sql.table, encoded, definition.version),
		);
		this.#record(encoded.id, { kind: "put", row: encoded.row });
	}
	update(key: unknown, set: unknown): void {
		const { definition, sql } = this.handle,
			encoded = definition.rows.key(key, "update"),
			values = this.#set(set, "update"),
			versions = jsonVersions(definition, values);
		this.#staged.push(
			stageUpdate(
				sql.update(values, encoded.params, versions),
				sql.table,
				encoded.key,
				values,
				recordedVersions(values, versions),
			),
		);
		this.#record(encoded.id, { kind: "update", set: values });
	}
	delete(key: unknown): void {
		const { definition, sql } = this.handle,
			encoded = definition.rows.key(key, "delete");
		this.#staged.push(
			stageDelete(
				{ sql: sql.delete, params: [...encoded.params] },
				sql.table,
				encoded.key,
			),
		);
		this.#record(encoded.id, { kind: "delete" });
	}
	updateWhere(where: unknown, set: unknown): void {
		const { definition, sql } = this.handle,
			condition = this.#where(where, "updateWhere"),
			values = this.#set(set, "updateWhere"),
			versions = jsonVersions(definition, values);
		this.#staged.push(
			stageUpdateWhere(
				sql.updateWhere(condition, values, versions),
				sql.table,
				condition,
				values,
				recordedVersions(values, versions),
			),
		);
		this.#bulk = true;
	}
	deleteWhere(where: unknown): void {
		const condition = this.#where(where, "deleteWhere"),
			{ sql } = this.handle;
		this.#staged.push(
			stageDeleteWhere(sql.deleteWhere(condition), sql.table, condition),
		);
		this.#bulk = true;
	}
	async get(key: unknown, context: Context): Promise<EvaluatedRow | undefined> {
		const { definition } = this.handle;
		if (this.#bulk)
			throw invalid(
				"read_after_bulk",
				`${definition.name}: tx.get after an updateWhere or deleteWhere on the table`,
			);
		const encoded = definition.rows.key(key, "get"),
			writes = this.#keys.get(encoded.id) ?? [];
		let index = writes.length - 1;
		while (index >= 0 && writes[index]!.kind === "update") index--;
		const reset = writes[index];
		let row =
			reset === undefined
				? ((await this.handle.get(encoded.key, context)) as
						| EvaluatedRow
						| undefined)
				: reset.kind === "put"
					? reset.row
					: undefined;
		for (index++; index < writes.length; index++) {
			const change = writes[index]!;
			if (row !== undefined && change.kind === "update")
				row = applySet(change.set, row, definition.name);
		}
		return row;
	}
	#set(input: unknown, what: string): SetNode {
		return compileSet(this.handle.definition, this.#input(input), what);
	}
	#where(input: unknown, what: string): WhereNode {
		return compileWhere(this.handle.definition, this.#input(input), what);
	}
	#input(input: unknown): unknown {
		return typeof input === "function"
			? input(this.handle.definition.refs)
			: input;
	}
	#record(key: string, change: Change): void {
		const prior = this.#keys.get(key);
		if (prior) prior.push(change);
		else this.#keys.set(key, [change]);
	}
}
