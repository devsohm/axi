import type { Context } from "../context/index.ts";
import { ObjectsError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import { diffRevisions } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import { Source, handedOut, type Batch, type WatchStart } from "../state/internal.ts";
import type { Query } from "./query.ts";
import type { Statement } from "./sql.ts";
import type { StagedWrite, Step } from "./step.ts";
import type { TableDefinition } from "./table.ts";
import type { TableHandle } from "./table-handle.ts";

export type QueryOwner = { readonly label: string; report(error: unknown): void };
type StoredRow = Readonly<Record<string, SqliteValue>>;
type CachedRow = { readonly stored: StoredRow; readonly value: JsonValue };
type Rows = { readonly value: JsonValue[]; readonly cache: Map<unknown, CachedRow> };
type Run = { readonly kind: "rows"; readonly rows: Rows } | { readonly kind: "failed"; readonly error: unknown };
type State =
	| { readonly kind: "pending" }
	| { readonly kind: "ready"; readonly rows: JsonValue[] }
	| { readonly kind: "failed"; readonly error: unknown; readonly rows: JsonValue[] | undefined }
	| { readonly kind: "closed"; readonly error: Error };
const failedFrame = Symbol("failed query frame");

export function checkLiveQuery(table: TableDefinition, query: Query, limit: unknown, label: string): void {
	if (query.table !== table)
		throw invalid("args", `${label}: self.query: a query of table "${query.table.name}" over "${table.name}"`);
	if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1)
		throw invalid("args", `${label}: self.query: a limit is required, a positive integer`);
}

export class LiveQueries {
	readonly #tables = new Map<string, Set<LiveQuery>>();
	add(query: LiveQuery): void {
		const table = query.handle.sql.table;
		let entries = this.#tables.get(table);
		if (!entries) {
			entries = new Set();
			this.#tables.set(table, entries);
		}
		entries.add(query);
	}
	delete(query: LiveQuery): void {
		const table = query.handle.sql.table,
			entries = this.#tables.get(table);
		entries?.delete(query);
		if (entries?.size === 0) this.#tables.delete(table);
	}
	on(table: string): ReadonlySet<LiveQuery> | undefined {
		return this.#tables.get(table);
	}
}

export function refreshOf(handles: Iterable<TableHandle>, context: Context): QueryRefresh | undefined {
	let affected: Set<LiveQuery> | undefined;
	for (const handle of handles) {
		const queries = handle.owner.queries.on(handle.sql.table);
		if (queries) {
			affected ??= new Set();
			for (const query of queries) affected.add(query);
		}
	}
	return affected ? new QueryRefresh([...affected], context) : undefined;
}
export class QueryRefresh {
	readonly write: StagedWrite;
	readonly #runs: Run[] = [];
	readonly #queries: readonly LiveQuery[];
	constructor(queries: readonly LiveQuery[], context: Context) {
		this.#queries = queries;
		this.write = {
			order: "write",
			apply: async (step) => {
				this.#runs.length = 0;
				for (const query of queries) this.#runs.push(await query.rerun(step, context));
				return [];
			},
		};
	}
	adopt(): void {
		this.#queries.forEach((query, index) => query.adopt(this.#runs[index]!));
	}
	committed(): void {}
	discarded(): void {}
}

export class LiveQuery extends Source {
	readonly handle: TableHandle;
	readonly #owner: QueryOwner;
	readonly #statement: Statement;
	#state: State = { kind: "pending" };
	#cache = new Map<unknown, CachedRow>();
	#before: JsonValue[] | typeof failedFrame | undefined;
	#revision = 0;
	#reported = false;
	constructor(handle: TableHandle, query: Query, limit: number, owner: QueryOwner, batch: Batch) {
		super(batch);
		this.handle = handle;
		this.#owner = owner;
		this.#statement = handle.sql.select(query.condition, query.order, undefined, limit);
	}
	get value(): JsonValue[] {
		switch (this.#state.kind) {
			case "ready":
				return this.#state.rows;
			case "failed":
			case "closed":
				throw this.#state.error;
			case "pending":
				throw new ObjectsError({ code: "not_ready", message: `${this.#owner.label}: a live query read before it ran` });
		}
	}
	override start(): WatchStart {
		return this.#state.kind === "failed"
			? { kind: "failed", error: this.#state.error, last: this.#state.rows }
			: { kind: "value", value: this.value };
	}
	async load(context: Context): Promise<void> {
		const revision = this.#revision,
			{ sql, params } = this.#statement;
		context.telemetry.metrics?.counter("objects.query.runs").add(1);
		const stored = await this.handle.store.read((executor) => executor.all<StoredRow>(sql, ...params), context);
		const rows = this.decode(stored, context);
		if (revision === this.#revision) {
			this.#cache = rows.cache;
			this.#state = { kind: "ready", rows: rows.value };
		}
	}
	async rerun(step: Step, context: Context): Promise<Run> {
		try {
			context.telemetry.metrics?.counter("objects.query.runs").add(1);
			return {
				kind: "rows",
				rows: this.decode(await step.all<StoredRow>(this.#statement.sql, ...this.#statement.params), context),
			};
		} catch (error) {
			return { kind: "failed", error };
		}
	}
	adopt(run: Run): void {
		const before = this.#state;
		if (before.kind === "closed") return;
		this.#revision++;
		if (this.watched && this.#before === undefined) this.#before = before.kind === "ready" ? before.rows : failedFrame;
		if (run.kind === "rows") {
			this.#reported = false;
			this.#cache = run.rows.cache;
			this.#state = { kind: "ready", rows: run.rows.value };
		} else {
			if (!this.#reported) this.#owner.report(handedOut(run.error));
			this.#reported = true;
			this.#state = {
				kind: "failed",
				error: run.error,
				rows: before.kind === "ready" || before.kind === "failed" ? before.rows : undefined,
			};
		}
		this.changed();
	}
	deliver(context: Context): void {
		const before = this.#before;
		this.#before = undefined;
		if (this.#state.kind === "ready") {
			const rows = this.#state.rows;
			const ops = before === failedFrame ? [["r", rows] as const] : diffRevisions(before!, rows);
			if (ops.length) this.publish(rows, ops, false, context);
		} else if (this.#state.kind === "failed" && before !== failedFrame) this.failWatches(this.#state.error, context);
	}
	detach(error: Error): void {
		this.handle.owner.queries.delete(this);
		this.#state = { kind: "closed", error };
		this.#before = undefined;
		this.endWatches();
	}
	private decode(stored: readonly StoredRow[], context: Context): Rows {
		const { key, rows } = this.handle.definition;
		const value: JsonValue[] = [],
			cache = new Map<unknown, CachedRow>();
		for (const current of stored) {
			const id = key.length === 1 ? current[key[0]!] : JSON.stringify(key.map((column) => current[column]));
			const prior = this.#cache.get(id);
			const row =
				prior && rows.physical.every((column) => prior.stored[column] === current[column])
					? prior.value
					: (rows.decode(current, context) as JsonValue);
			value.push(row);
			cache.set(id, { stored: current, value: row });
		}
		return { value, cache };
	}
}
