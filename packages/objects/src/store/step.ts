import type { SqliteExecutor, SqliteValue } from "../sqlite/index.ts";
import type { IdAllocator } from "./allocator.ts";
import type { TableRecord } from "./catalog.ts";
import type { StoreWrite } from "./writes.ts";

export type WriteOrder = "retire" | "create" | "write";
export type StagedWrite = {
	readonly order: WriteOrder;
	apply(step: Step): Promise<readonly StoreWrite[]>;
};
export class Step {
	readonly executor: SqliteExecutor;
	readonly seq: number;
	readonly ids: IdAllocator;
	readonly created: number[] = [];
	readonly tables = new Map<string, TableRecord>();
	readonly #catalog: ReadonlyMap<string, TableRecord>;
	statements = 0;
	rows = 0;
	constructor(executor: SqliteExecutor, seq: number, ids: IdAllocator, catalog: ReadonlyMap<string, TableRecord>) {
		this.executor = executor;
		this.seq = seq;
		this.ids = ids;
		this.#catalog = catalog;
	}
	table(name: string): TableRecord | undefined {
		return this.tables.get(name) ?? this.#catalog.get(name);
	}
	records(): TableRecord[] {
		return [...new Map([...this.#catalog, ...this.tables]).values()];
	}
	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		this.statements += 1;
		return this.executor.run(sql, ...params);
	}
	runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
		this.statements += 1;
		return this.executor.runCounted(sql, ...params);
	}
	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		this.statements += 1;
		return this.executor.get<T>(sql, ...params);
	}
	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		this.statements += 1;
		return this.executor.all<T>(sql, ...params);
	}
}
