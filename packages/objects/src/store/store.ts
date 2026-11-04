import { awaitWithContext, type Context } from "../context/index.ts";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteValue,
} from "../sqlite/index.ts";
import { ObjectsError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import type { Batch } from "../state/internal.ts";
import { IdAllocator } from "./allocator.ts";
import type { ArchivePart } from "./archive.ts";
import type { Backend } from "./backend.ts";
import { readCatalog, writeCatalog, type TableRecord } from "./catalog.ts";
import { Claims } from "./claims.ts";
import { StoreExport } from "./export.ts";
import { Outbox, OUTBOX_FORMAT } from "./outbox.ts";
import { applyStoreSchema, TABLES, type MetaRow } from "./schema.ts";
import { Step, type StagedWrite } from "./step.ts";
import type { StoreWrite } from "./writes.ts";

export interface Store {
	readonly lastSeq: number;
	readonly outbox: Outbox | undefined;
	export(context: Context): AsyncIterableIterator<ArchivePart>;
	close(context: Context): Promise<void>;
}
export type StoreOptions = { readonly outbox?: boolean };
export type CommitFence = {
	admit(): boolean;
	adopt(seq: number, ids: readonly number[], rows: number): void;
};
export type SeriesCommit = {
	check(step: Step): Promise<void>;
	readonly writes: readonly StagedWrite[];
};
export type SeriesResult = {
	readonly stored: number;
	readonly refused?: unknown;
};
export type Attachment = {
	readonly failed: (error: unknown) => void;
	readonly batch: Batch;
};
export type Replayed = {
	readonly lastSeq: number;
	readonly nextId: number;
	readonly tables: ReadonlyMap<string, TableRecord>;
};
type Status =
	| { readonly kind: "open" }
	| { readonly kind: "failed"; readonly error: unknown }
	| { readonly kind: "closed" };
export async function openStore(
	backend: Backend,
	context: Context,
	options: StoreOptions = {},
): Promise<Store> {
	try {
		context.abortSignal?.throwIfAborted();
		let meta = await applyStoreSchema(backend.db);
		if (
			options.outbox !== undefined &&
			options.outbox !== (meta.outbox === 1)
		) {
			const enabled = options.outbox,
				floor = enabled ? meta.last_seq : 0;
			await backend.db.transaction(async (tx) => {
				await tx.run(
					`UPDATE ${TABLES.meta} SET outbox = ?, outbox_floor = ? WHERE singleton = 1`,
					Number(enabled),
					floor,
				);
				if (!enabled) await tx.run(`DELETE FROM ${TABLES.outbox}`);
			});
			meta = { ...meta, outbox: Number(enabled), outbox_floor: floor };
		}
		return new ObjectsStore(backend.db, meta, await readCatalog(backend.db));
	} catch (error) {
		try {
			await backend.db.close();
		} catch {}
		throw error;
	}
}
const failedStorage = (cause: unknown): ObjectsError =>
	new ObjectsError(
		{
			code: "unavailable",
			reason: "storage_failed",
			message: "store: storage failed",
		},
		{ cause },
	);
export class ObjectsStore implements Store {
	readonly claims = new Claims();
	readonly #db: SqliteDatabase;
	readonly #ids: IdAllocator;
	readonly #catalog: Map<string, TableRecord>;
	readonly #migratingTables = new Map<string, number>();
	readonly #outbox: Outbox | undefined;
	readonly #exports = new Set<() => void>();
	#seq: number;
	#committedId: number;
	#status: Status = { kind: "open" };
	#diverged = false;
	#queue = Promise.resolve();
	#activeReads = 0;
	#drained: (() => void) | undefined;
	#attachment: Attachment | undefined;
	#closed: Promise<void> | undefined;
	constructor(
		db: SqliteDatabase,
		meta: MetaRow,
		catalog: Map<string, TableRecord>,
	) {
		this.#db = db;
		this.#seq = meta.last_seq;
		this.#committedId = meta.next_id;
		this.#ids = new IdAllocator(meta.next_id);
		this.#catalog = catalog;
		this.#outbox =
			meta.outbox === 1 ? new Outbox(this, meta.outbox_floor) : undefined;
	}
	get lastSeq(): number {
		return this.#seq;
	}
	get nextId(): number {
		return this.#committedId;
	}
	get ids(): IdAllocator {
		return this.#ids;
	}
	get outbox(): Outbox | undefined {
		return this.#outbox;
	}
	get recordsOutbox(): boolean {
		return this.#outbox !== undefined;
	}
	get batch(): Batch | undefined {
		return this.#attachment?.batch;
	}
	get tables(): ReadonlyMap<string, TableRecord> {
		return this.#catalog;
	}
	table(name: string): TableRecord | undefined {
		return this.#catalog.get(name);
	}
	tableVersion(name: string): number | undefined {
		const stored = this.#catalog.get(name)?.version;
		const pending = this.#migratingTables.get(name);
		return pending === undefined
			? stored
			: Math.max(pending, stored ?? pending);
	}
	announceTable(name: string, version: number): () => void {
		this.#migratingTables.set(name, version);
		return () => {
			if (this.#migratingTables.get(name) === version)
				this.#migratingTables.delete(name);
		};
	}
	mintId(): number {
		this.assertUsable();
		return this.#ids.mint();
	}
	attach(attachment: Attachment): void {
		if (this.#attachment)
			throw invalid("args", "store: already attached to an open host");
		this.#attachment = attachment;
	}
	detach(): void {
		this.#attachment = undefined;
	}
	export(context: Context): AsyncIterableIterator<ArchivePart> {
		this.assertUsable();
		return new StoreExport(this, context);
	}
	take(end: () => void): Promise<() => void> {
		let resume!: () => void;
		const held = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const release = (): void => {
			this.#exports.delete(end);
			resume();
		};
		this.#exports.add(end);
		const taken = this.#queue.then(() => {
			if (this.#status.kind === "closed") {
				release();
				end();
			}
			return release;
		});
		this.#queue = taken.then(() => held);
		return taken;
	}
	#enqueue<T>(work: () => Promise<T>): Promise<T> {
		const result = this.#queue.then(work);
		this.#queue = result.then(
			() => {},
			() => {},
		);
		return result;
	}
	async #transaction<T>(
		work: (executor: SqliteExecutor) => Promise<T>,
		refused?: (error: unknown) => void,
	): Promise<T> {
		let rejection: { readonly value: unknown } | undefined;
		try {
			return await this.#db.transaction(async (tx) => {
				try {
					return await work(tx);
				} catch (value) {
					rejection = { value };
					throw value;
				}
			});
		} catch (error) {
			if (rejection && rejection.value === error) {
				refused?.(error);
				throw error;
			}
			throw this.#fail(error);
		}
	}
	async commit(
		writes: readonly StagedWrite[],
		fence: CommitFence,
		context: Context,
	): Promise<number> {
		this.assertUsable();
		return this.#enqueue(async () => {
			this.assertUsable();
			if (!fence.admit())
				throw new ObjectsError({
					code: "released",
					reason: "discarded",
					message: "store: the commit's attempt ended",
				});
			let created: readonly number[] = [];
			let rows = 0;
			if (writes.length) {
				if (this.#seq >= Number.MAX_SAFE_INTEGER)
					throw this.#fail(
						new Error("store: no seq past Number.MAX_SAFE_INTEGER"),
					);
				const seq = this.#seq + 1;
				const committed = await this.#transaction(async (executor) => {
					const step = new Step(executor, seq, this.#ids, this.#catalog);
					const nextId = await this.#applyWrites(step, writes);
					await this.#writeMeta(step, nextId);
					return { step, nextId };
				});
				this.#seq = seq;
				this.#committedId = committed.nextId;
				created = committed.step.created;
				rows = committed.step.rows;
				for (const [name, record] of committed.step.tables)
					this.#catalog.set(name, record);
				context.telemetry.metrics?.counter("objects.store.commits").add(1);
				context.telemetry.metrics
					?.counter("objects.store.statements")
					.add(committed.step.statements);
			}
			try {
				fence.adopt(this.#seq, created, rows);
			} catch (error) {
				throw this.#fail(error);
			}
			return this.#seq;
		});
	}
	async commitSeries(
		commits: readonly SeriesCommit[],
		receive: (index: number, seq: number, ids: readonly number[], rows: number) => void,
		context: Context,
	): Promise<SeriesResult> {
		this.assertUsable();
		return this.#enqueue(async () => {
			this.assertUsable();
			const writing = commits.reduce(
				(n, part) => n + Number(part.writes.length > 0),
				0,
			);
			if (this.#seq + writing > Number.MAX_SAFE_INTEGER)
				throw this.#fail(
					new Error("store: no seq past Number.MAX_SAFE_INTEGER"),
				);
			const done = await this.#transaction(async (executor) => {
				let seq = this.#seq,
					nextId = this.#committedId,
					statements = 0;
				let catalog: Map<string, TableRecord> | undefined;
				let last: Step | undefined;
				let refused: { readonly error: unknown } | undefined;
				const receipts: { seq: number; ids: readonly number[]; rows: number }[] = [];
				let statementFailed = false;
				const watch = async <T>(call: () => Promise<T>): Promise<T> => {
					try {
						return await call();
					} catch (error) {
						statementFailed = true;
						throw error;
					}
				};
				const checked: SqliteExecutor = {
					exec: (sql) => watch(() => executor.exec(sql)),
					run: (sql, ...params) => watch(() => executor.run(sql, ...params)),
					runCounted: (sql, ...params) =>
						watch(() => executor.runCounted(sql, ...params)),
					get: <T extends object>(sql: string, ...params: SqliteValue[]) =>
						watch(() => executor.get<T>(sql, ...params)),
					all: <T extends object>(sql: string, ...params: SqliteValue[]) =>
						watch(() => executor.all<T>(sql, ...params)),
				};
				for (const commit of commits) {
					const check = new Step(
						checked,
						seq + 1,
						this.#ids,
						catalog ?? this.#catalog,
					);
					statementFailed = false;
					try {
						await commit.check(check);
					} catch (error) {
						if (statementFailed) throw error;
						refused = { error };
						break;
					} finally {
						statements += check.statements;
					}
					if (commit.writes.length === 0) {
						receipts.push({ seq, ids: [], rows: 0 });
						continue;
					}
					last = new Step(
						executor,
						seq + 1,
						this.#ids,
						catalog ?? this.#catalog,
					);
					nextId = await this.#applyWrites(last, commit.writes);
					statements += last.statements;
					seq = last.seq;
					if (last.tables.size > 0) {
						catalog ??= new Map(this.#catalog);
						for (const [name, record] of last.tables) catalog.set(name, record);
					}
					receipts.push({ seq, ids: last.created, rows: last.rows });
				}
				if (last !== undefined) {
					await this.#writeMeta(last, nextId);
					statements++;
				}
				return { seq, nextId, statements, catalog, refused, receipts };
			});
			const written = done.seq - this.#seq;
			this.#seq = done.seq;
			this.#committedId = done.nextId;
			if (done.catalog)
				for (const [name, record] of done.catalog)
					this.#catalog.set(name, record);
			context.telemetry.metrics?.counter("objects.store.commits").add(written);
			context.telemetry.metrics
				?.counter("objects.store.statements")
				.add(done.statements);
			try {
				for (const [index, receipt] of done.receipts.entries())
					receive(index, receipt.seq, receipt.ids, receipt.rows);
			} catch (error) {
				throw this.#fail(error);
			}
			return done.refused === undefined
				? { stored: done.receipts.length }
				: { stored: done.receipts.length, refused: done.refused.error };
		});
	}
	async #applyWrites(
		step: Step,
		writes: readonly StagedWrite[],
	): Promise<number> {
		const recorded: StoreWrite[] | undefined = this.#outbox ? [] : undefined;
		for (const order of ["retire", "create", "write"] as const)
			for (const write of writes)
				if (write.order === order) {
					const values = await write.apply(step);
					for (const value of values) {
						if (value.kind === "put") step.rows++;
						else if (value.kind === "update" || value.kind === "delete" || value.kind === "updateWhere" || value.kind === "deleteWhere") step.rows += value.count;
					}
					recorded?.push(...values);
				}
		await writeCatalog(step);
		const nextId = this.#ids.value;
		if (recorded)
			await step.run(
				`INSERT INTO ${TABLES.outbox} (seq, format, next_id, writes) VALUES (?, ?, ?, ?)`,
				step.seq,
				OUTBOX_FORMAT,
				nextId,
				JSON.stringify(recorded),
			);
		return nextId;
	}
	#writeMeta(step: Step, nextId: number): Promise<void> {
		return step.run(
			`UPDATE ${TABLES.meta} SET last_seq = ?, next_id = ? WHERE singleton = 1`,
			step.seq,
			nextId,
		);
	}
	read<T>(
		read: (executor: SqliteExecutor) => Promise<T>,
		context: Context,
	): Promise<T> {
		return this.#guard(() => read(this.#db), context);
	}
	readTransaction<T>(
		read: (executor: SqliteExecutor) => Promise<T>,
		context: Context,
	): Promise<T> {
		return this.#guard(() => this.#db.transaction(read), context);
	}
	maintain(write: (executor: SqliteExecutor) => Promise<void>): Promise<void> {
		return this.#guard(() => this.#db.transaction(write));
	}
	async #guard<T>(work: () => Promise<T>, context?: Context): Promise<T> {
		this.assertUsable();
		this.#activeReads++;
		let value: T;
		try {
			value = await work();
		} catch (error) {
			this.assertUsable();
			if (context?.abortSignal?.aborted)
				throw new ObjectsError(
					{ code: "aborted", message: "store: read aborted" },
					{ cause: context.abortSignal.reason },
				);
			throw this.#fail(error);
		} finally {
			this.#activeReads--;
			if (!this.#activeReads) this.#drained?.();
		}
		if (context !== undefined) this.assertUsable();
		return value;
	}
	async replay(
		apply: (
			executor: SqliteExecutor,
			catalog: ReadonlyMap<string, TableRecord>,
		) => Promise<Replayed>,
		isDivergence: (error: unknown) => boolean,
	): Promise<void> {
		this.#canReplay();
		return this.#enqueue(async () => {
			this.#canReplay();
			const unlock = this.claims.lock();
			try {
				const result = await this.#transaction(
					(executor) => apply(executor, this.#catalog),
					(error) => {
						if (isDivergence(error)) this.#diverged = true;
					},
				);
				this.#seq = result.lastSeq;
				this.#committedId = result.nextId;
				this.#ids.raise(result.nextId - 1);
				for (const [name, table] of result.tables)
					this.#catalog.set(name, table);
			} finally {
				unlock();
			}
		});
	}
	#canReplay(): void {
		this.assertUsable();
		if (this.#diverged)
			throw invalid("args", "store: diverged; a batch can no longer apply");
		if (this.claims.held)
			throw invalid(
				"args",
				"store: an owner holds claims; a batch would stale its memory",
			);
	}
	close(context: Context): Promise<void> {
		this.#closed ??= this.#close();
		return awaitWithContext(this.#closed, context);
	}
	async #close(): Promise<void> {
		this.#status = { kind: "closed" };
		for (const end of [...this.#exports]) end();
		await this.#queue;
		if (this.#activeReads)
			await new Promise<void>((resolve) => {
				this.#drained = resolve;
			});
		await this.#db.close();
	}
	assertUsable(): void {
		if (this.#status.kind === "failed") throw failedStorage(this.#status.error);
		if (this.#status.kind === "closed")
			throw new ObjectsError({
				code: "released",
				reason: "closed",
				message: "store: closed",
			});
	}
	#fail(error: unknown): ObjectsError {
		if (this.#status.kind === "open") {
			this.#status = { kind: "failed", error };
			this.#attachment?.failed(error);
		}
		return failedStorage(error);
	}
}
