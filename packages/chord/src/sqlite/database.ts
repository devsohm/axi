export type SqliteValue = null | number | bigint | string | Uint8Array;

export interface SqliteExecutor {
	exec(sql: string): Promise<void>;
	run(sql: string, ...params: SqliteValue[]): Promise<void>;
	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined>;
	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]>;
}

export interface SqliteDatabase extends SqliteExecutor {
	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}
