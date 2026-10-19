import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "./database.ts";
import { OperationQueue } from "./queue.ts";

type Binding = ArrayBuffer | string | number | null;
type Row = Record<string, Binding>;
export type DurableObjectSqliteStorage = {
	readonly sql: {
		exec(
			query: string,
			...bindings: Binding[]
		): {
			next(): { readonly done?: false; readonly value: Row } | { readonly done: true; readonly value?: undefined };
			toArray(): Row[];
		};
	};
	transaction<T>(closure: () => Promise<T>): Promise<T>;
};

const queues = new WeakMap<DurableObjectSqliteStorage, OperationQueue>();

function parameter(value: SqliteValue): Binding {
	if (value instanceof Uint8Array) return value.slice().buffer;
	if (typeof value !== "bigint") return value;
	if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new RangeError(`Durable Object SQL cannot bind ${value} without losing precision`);
	}
	return Number(value);
}

const parameters = (values: readonly SqliteValue[]): Binding[] => values.map(parameter);

function decode<T extends object>(row: Row): T {
	const columns: Record<string, unknown> = row;
	for (const key in columns) {
		const value = columns[key];
		if (value instanceof ArrayBuffer) columns[key] = new Uint8Array(value);
	}
	return row as T;
}

class Commands implements SqliteExecutor {
	protected readonly storage: DurableObjectSqliteStorage;

	constructor(storage: DurableObjectSqliteStorage) {
		this.storage = storage;
	}
	async exec(sql: string): Promise<void> {
		this.check();
		this.storage.sql.exec(sql);
	}
	async run(sql: string, ...params: SqliteValue[]): Promise<void> {
		this.check();
		this.storage.sql.exec(sql, ...parameters(params));
	}
	async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		this.check();
		const next = this.storage.sql.exec(sql, ...parameters(params)).next();
		return next.done ? undefined : decode<T>(next.value);
	}
	async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		this.check();
		return this.storage.sql
			.exec(sql, ...parameters(params))
			.toArray()
			.map((row) => decode<T>(row));
	}
	protected check(): void {}
}

class TransactionCommands extends Commands {
	active = true;
	protected override check(): void {
		if (!this.active) throw new Error("SQLite transaction handle is no longer active");
	}
}

export class DurableObjectSqliteDatabase extends Commands implements SqliteDatabase {
	readonly #queue: OperationQueue;

	constructor(storage: DurableObjectSqliteStorage) {
		super(storage);
		let queue = queues.get(storage);
		if (queue === undefined) {
			queue = new OperationQueue();
			queues.set(storage, queue);
		}
		this.#queue = queue;
	}
	override exec(sql: string): Promise<void> {
		return this.#queue.run(() => super.exec(sql));
	}
	override run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.#queue.run(() => super.run(sql, ...params));
	}
	override get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.#queue.run(() => super.get<T>(sql, ...params));
	}
	override all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.#queue.run(() => super.all<T>(sql, ...params));
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.#queue.hold(() =>
			this.storage.transaction(async () => {
				const handle = new TransactionCommands(this.storage);
				try {
					return await callback(handle);
				} finally {
					handle.active = false;
				}
			}),
		);
	}

	close(): Promise<void> {
		return this.#queue.run(() => {});
	}
}
