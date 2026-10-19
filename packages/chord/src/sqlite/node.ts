import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "./database.ts";
import { OperationQueue } from "./queue.ts";

export type NodeSqliteDatabaseOptions = { readonly walAutoCheckpointPages?: number; readonly busyTimeoutMs?: number };
type TransactionScope = { active: boolean };

abstract class Statements implements SqliteExecutor {
	protected readonly database: DatabaseSync;
	protected readonly statements: Map<string, StatementSync>;

	constructor(database: DatabaseSync, statements: Map<string, StatementSync>) {
		this.database = database;
		this.statements = statements;
	}

	#prepared(sql: string): StatementSync {
		const cached = this.statements.get(sql);
		if (cached !== undefined) return cached;
		const statement = this.database.prepare(sql);
		this.statements.set(sql, statement);
		return statement;
	}

	exec(sql: string): Promise<void> {
		return this.runOperation(() => {
			this.database.exec(sql);
		});
	}
	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.runOperation(() => {
			this.#prepared(sql).run(...params);
		});
	}
	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.runOperation(() => this.#prepared(sql).get(...params) as T | undefined);
	}
	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.runOperation(() => this.#prepared(sql).all(...params) as T[]);
	}
	protected abstract runOperation<T>(operation: () => T): Promise<T>;
}

class TransactionStatements extends Statements {
	readonly #scope: TransactionScope;
	constructor(database: DatabaseSync, statements: Map<string, StatementSync>, scope: TransactionScope) {
		super(database, statements);
		this.#scope = scope;
	}
	protected async runOperation<T>(operation: () => T): Promise<T> {
		if (!this.#scope.active) throw new Error("SQLite transaction handle is no longer active");
		return operation();
	}
}

export class NodeSqliteDatabase extends Statements implements SqliteDatabase {
	readonly #queue = new OperationQueue();
	#closed = false;

	constructor(database: DatabaseSync) {
		super(database, new Map());
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.#queue.runAsync(async () => {
			this.database.exec("BEGIN IMMEDIATE");
			const scope = { active: true };
			try {
				const result = await callback(new TransactionStatements(this.database, this.statements, scope));
				scope.active = false;
				this.database.exec("COMMIT");
				return result;
			} catch (error) {
				scope.active = false;
				try {
					this.database.exec("ROLLBACK");
				} catch (rollback) {
					throw new AggregateError([error, rollback], "SQLite transaction failed and rollback failed");
				}
				throw error;
			}
		});
	}

	close(): Promise<void> {
		return this.#queue.run(() => {
			if (this.#closed) return;
			this.#closed = true;
			this.statements.clear();
			try {
				this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				this.database.close();
			}
		});
	}
	protected runOperation<T>(operation: () => T): Promise<T> {
		return this.#queue.run(operation);
	}
}

export async function openNodeSqliteDatabase(
	path: string,
	options: NodeSqliteDatabaseOptions = {},
): Promise<NodeSqliteDatabase> {
	const checkpoint = options.walAutoCheckpointPages ?? 1000;
	const timeout = options.busyTimeoutMs ?? 5000;
	if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
	const adapter = new NodeSqliteDatabase(new DatabaseSync(path, { timeout }));
	try {
		await adapter.exec("PRAGMA journal_mode = WAL");
		await adapter.exec("PRAGMA synchronous = NORMAL");
		await adapter.exec(`PRAGMA wal_autocheckpoint = ${checkpoint}`);
		return adapter;
	} catch (error) {
		try {
			await adapter.close();
		} catch {}
		throw error;
	}
}
