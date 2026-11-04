import { withoutAbortSignal, type Context } from "../context/index.ts";
import {
	track,
	type Change,
	type Draft,
	type Prepared,
	type Tracker,
} from "../delta/index.ts";
import { ObjectsError } from "../data/index.ts";
import { asObjectsError } from "../data/internal.ts";
import type { JobHandle, Outcome, Run, StartOptions } from "../jobs/index.ts";
import type { Columns, PutRowOf, RowOf } from "../store/columns.ts";
import type { Condition, SetOf } from "../store/expression.ts";
import type { ColumnRefs, Query } from "../store/query.ts";
import { refusalOf } from "../store/refusal.ts";
import type { StagedWrite } from "../store/step.ts";
import type { ObjectsStore } from "../store/store.ts";
import type { KeyOf } from "../store/table.ts";
import { TableChanges } from "../store/table-changes.ts";
import { refreshOf } from "../store/live-query.ts";
import {
	TableHandle,
	ROWS_PAGE,
	type Page,
	type PageOptions,
	type Table,
} from "../store/table-handle.ts";
import type { CommitPersistence, JsonObject } from "./definition.ts";
import type { Documents } from "./documents.ts";
import type { SealToken } from "./fence.ts";
import {
	Keyed,
	Singleton,
	type KeyedHandle,
	type SingletonHandle,
} from "./handles.ts";
import type { KeyedSlot } from "./keyed-slot.ts";
import {
	checkReadable,
	type Stored,
	type StoredChange,
} from "./persistence.ts";
import type { DocumentSlot, SingletonSlot } from "./slot.ts";

export interface Tx {
	draft<T extends JsonObject>(handle: SingletonHandle<T>): Promise<Draft<T>>;
	draft<T extends JsonObject>(
		handle: KeyedHandle<T>,
		key: string,
	): Promise<Draft<T>>;
	retire(handle: SingletonHandle<JsonObject>): Promise<void>;
	retire(handle: KeyedHandle<JsonObject>, key: string): Promise<void>;
	start<A, R, S>(
		job: JobHandle<A, R, S>,
		args: A,
		options?: StartOptions,
	): Run<Outcome<A, R, S>>;
	get<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		key: KeyOf<C, K>,
	): Promise<RowOf<C> | undefined>;
	page<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		q: Query<C, K>,
		limit: number,
		options?: PageOptions,
	): Promise<Page<RowOf<C>>>;
	rows<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		q: Query<C, K>,
	): AsyncIterable<RowOf<C>>;
	put<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		row: PutRowOf<C>,
	): void;
	update<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		key: KeyOf<C, K>,
		set: SetOf<C, K> | ((row: ColumnRefs<C>) => SetOf<C, K>),
	): void;
	delete<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		key: KeyOf<C, K>,
	): void;
	updateWhere<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		where: (row: ColumnRefs<C>) => Condition,
		set: SetOf<C, K> | ((row: ColumnRefs<C>) => SetOf<C, K>),
	): void;
	deleteWhere<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		where: (row: ColumnRefs<C>) => Condition,
	): void;
}
export interface Staged {
	adopt(): void;
	committed(): void;
	discarded(): void;
}
type Entry = {
	readonly slot: DocumentSlot;
	readonly key: string;
	draft:
		| {
				readonly tracker: Tracker<JsonObject>;
				readonly change: Change<JsonObject>;
		  }
		| undefined;
	retire: boolean;
	found: Stored | undefined;
};
type Adoption = {
	readonly entry: Entry;
	readonly retires: boolean;
	readonly write:
		| {
				readonly tracker: Tracker<JsonObject>;
				readonly prepared: Prepared<JsonObject>;
				readonly stored: StoredChange | undefined;
		  }
		| undefined;
};
type StagingJob<A, R, S> = {
	stage(
		tx: Transaction,
		args: A,
		context: Context,
		options: StartOptions,
	): Run<Outcome<A, R, S>>;
};

export class Transaction implements Tx {
	readonly documents: Documents;
	readonly token: SealToken;
	readonly #release: () => void;
	readonly #context: Context;
	readonly #persistence: CommitPersistence;
	readonly #entries = new Map<DocumentSlot, Map<string, Entry>>();
	#staged: Map<object, Staged> | undefined;
	#writes:
		| { readonly store: ObjectsStore; readonly staged: StagedWrite[] }
		| undefined;
	#tables: Map<TableHandle, TableChanges> | undefined;
	#pending = 0;
	#adoptions: readonly Adoption[] = [];
	#rows = 0;
	#phase:
		| "open"
		| "preparing"
		| "stepping"
		| "committed"
		| "discarded"
		| "cut" = "open";
	#rejectQueued: ((error: unknown) => void) | undefined;
	constructor(
		documents: Documents,
		token: SealToken,
		release: () => void,
		context: Context,
		persistence: CommitPersistence = { kind: "immediate" },
	) {
		this.documents = documents;
		this.token = token;
		this.#release = release;
		this.#context = context;
		this.#persistence = persistence;
	}
	stageStore(store: ObjectsStore): StagedWrite[] {
		this.#writes ??= { store, staged: [] };
		return this.#writes.staged;
	}
	committed(): { readonly documents: number; readonly ops: number; readonly writes: number; readonly rows: number } {
		let ops = 0;
		for (const adoption of this.#adoptions) ops += adoption.write?.prepared.ops.length ?? 0;
		return { documents: this.#adoptions.length, ops, writes: this.#writes?.staged.length ?? 0, rows: this.#rows };
	}
	draft<T extends JsonObject>(handle: SingletonHandle<T>): Promise<Draft<T>>;
	draft<T extends JsonObject>(
		handle: KeyedHandle<T>,
		key: string,
	): Promise<Draft<T>>;
	draft<T extends JsonObject>(
		handle: SingletonHandle<T> | KeyedHandle<T>,
		key = "",
	): Promise<Draft<T>> {
		try {
			const slot = this.#slot(handle);
			return this.draftSlot(slot, key === "" ? key : slot.key(key)) as Promise<
				Draft<T>
			>;
		} catch (error) {
			return Promise.reject(error);
		}
	}
	async draftSlot(slot: DocumentSlot, key: string): Promise<Draft<JsonObject>> {
		const entry = this.#entry(slot, key),
			disk = slot.persisted;
		if (!entry.draft && !entry.retire && disk?.cold(key)) {
			await this.#track(disk.load(key, this.#context, this.token));
			this.#assertOpen();
		}
		if (!entry.draft) {
			const tracker =
				(!entry.retire && slot.current(key)) ||
				track(slot.initial(this.#context));
			entry.draft = { tracker, change: tracker.beginChange() };
		}
		return entry.draft.change.state;
	}
	retire(handle: SingletonHandle<JsonObject>): Promise<void>;
	retire(handle: KeyedHandle<JsonObject>, key: string): Promise<void>;
	async retire(
		handle: SingletonHandle<JsonObject> | KeyedHandle<JsonObject>,
		key = "",
	): Promise<void> {
		const slot = this.#slot(handle),
			at = key === "" ? key : slot.key(key),
			entry = this.retireSlot(slot, at),
			disk = slot.persisted;
		if (entry.found !== undefined || !disk?.cold(at)) return;
		const found = await this.#track(disk.persistence.find(at, this.#context));
		this.#assertOpen();
		if (found) {
			try {
				checkReadable(
					{ version: found.stored.version, fingerprint: found.fingerprint },
					disk.definition.current,
				);
			} catch (error) {
				const failure = asObjectsError(error, slot.owner.label);
				slot.owner.fail(failure);
				throw failure;
			}
		}
		entry.found = found?.stored;
	}
	retireSlot(slot: DocumentSlot, key: string): Entry {
		const entry = this.#entry(slot, key);
		entry.draft?.change.abort();
		entry.draft = undefined;
		entry.retire = true;
		return entry;
	}
	start<A, R, S>(
		job: JobHandle<A, R, S>,
		args: A,
		options: StartOptions = {},
	): Run<Outcome<A, R, S>> {
		return (job as JobHandle<A, R, S> & StagingJob<A, R, S>).stage(
			this,
			args,
			this.#context,
			options,
		);
	}
	get<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		key: KeyOf<C, K>,
	): Promise<RowOf<C> | undefined> {
		const handle = this.#handle(table),
			overlay = this.#tables?.get(handle);
		return this.#track(
			overlay
				? overlay.get(key, this.#context)
				: handle.get(key, this.#context),
		) as Promise<RowOf<C> | undefined>;
	}
	page<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		q: Query<C, K>,
		limit: number,
		options: PageOptions = {},
	): Promise<Page<RowOf<C>>> {
		return this.#track(
			this.#handle(table).page(
				q as unknown as Query,
				limit,
				this.#context,
				options,
			),
		) as Promise<Page<RowOf<C>>>;
	}
	async *rows<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		q: Query<C, K>,
	): AsyncIterable<RowOf<C>> {
		let after: string | undefined;
		do {
			const page = await this.page(
				table,
				q,
				ROWS_PAGE,
				after === undefined ? {} : { after },
			);
			yield* page.items;
			after = page.next;
		} while (after !== undefined);
	}
	put<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		row: PutRowOf<C>,
	): void {
		this.#changes(table).put(row);
	}
	update<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		key: KeyOf<C, K>,
		set: SetOf<C, K> | ((row: ColumnRefs<C>) => SetOf<C, K>),
	): void {
		this.#changes(table).update(key, set);
	}
	delete<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		key: KeyOf<C, K>,
	): void {
		this.#changes(table).delete(key);
	}
	updateWhere<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		where: (row: ColumnRefs<C>) => Condition,
		set: SetOf<C, K> | ((row: ColumnRefs<C>) => SetOf<C, K>),
	): void {
		this.#changes(table).updateWhere(where, set);
	}
	deleteWhere<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		where: (row: ColumnRefs<C>) => Condition,
	): void {
		this.#changes(table).deleteWhere(where);
	}
	stage<S extends Staged>(owner: object, make: () => S): S {
		this.#assertOpen();
		this.#staged ??= new Map();
		const existing = this.#staged.get(owner);
		if (existing) return existing as S;
		const value = make();
		this.#staged.set(owner, value);
		return value;
	}
	staged<S extends Staged>(owner: object): S | undefined {
		return this.#staged?.get(owner) as S | undefined;
	}
	commit(): void | Promise<void> {
		this.#assertOpen();
		if (this.#pending)
			throw new Error(
				`${this.documents.label}: the callback settled before its pending tx operations`,
			);
		if (this.#tables) {
			const refresh = refreshOf(this.#tables.keys(), this.#context);
			if (refresh) { this.#writes!.staged.push(refresh.write); this.stage(refresh, () => refresh); }
		}
		this.#phase = "preparing";
		this.#context.abortSignal?.throwIfAborted();
		const changes: Adoption[] = [];
		for (const group of this.#entries.values())
			for (const entry of group.values()) {
				const draft = entry.draft;
				let prepared = draft?.change.prepare();
				if (prepared?.ops.length === 0) {
					prepared.abort();
					prepared = undefined;
				}
				const { slot, key } = entry,
					retires =
						entry.retire &&
						(slot.current(key) !== undefined || entry.found !== undefined);
				if (!prepared && !retires) continue;
				const disk = slot.persisted;
				const stored = disk?.stage(
					key,
					{ prepared, retires },
					disk.stored(key) ?? entry.found,
					this.stageStore(disk.persistence.store),
					this.#persistence,
				);
				changes.push({
					entry,
					retires,
					write:
						prepared && draft
							? { tracker: draft.tracker, prepared, stored }
							: undefined,
				});
			}
		this.#adoptions = changes;
		if (this.#writes)
			return this.#step(this.#writes.store, this.#writes.staged, changes);
		this.#adopt(changes);
		this.#phase = "committed";
	}
	async #step(
		store: ObjectsStore,
		writes: readonly StagedWrite[],
		changes: readonly Adoption[],
	): Promise<void> {
		const interrupted = new Promise<never>((_resolve, reject) => {
			this.#rejectQueued = reject;
		});
		try {
			await Promise.race([
				interrupted,
				store.commit(
					writes,
					{
						admit: () => {
							if (this.#phase !== "preparing" || this.token.sealed)
								return false;
							this.#phase = "stepping";
							return true;
						},
						adopt: (_seq, _ids, rows) => { this.#rows = rows; this.#adopt(changes); },
					},
					withoutAbortSignal(this.#context),
				),
			]);
		} catch (error) {
			if (this.#phase === "cut") throw this.#cutError();
			const refusal = refusalOf(error, this.documents.label);
			if (refusal?.kind === "broken") this.documents.fail(refusal.error);
			throw refusal?.error ?? error;
		} finally {
			this.#rejectQueued = undefined;
		}
		this.#phase = "committed";
	}
	#adopt(changes: readonly Adoption[]): void {
		if (!changes.length && !this.#staged) return;
		this.documents.batch.commit(() => {
			for (const { entry, retires, write } of changes) {
				if (retires) entry.slot.retire(entry.key);
				if (write)
					entry.slot.adopt(
						entry.key,
						write.tracker,
						write.prepared,
						write.stored,
					);
			}
			for (const staged of this.#staged?.values() ?? []) staged.adopt();
		}, this.#context);
	}
	discard(): void {
		if (this.#phase !== "cut") {
			this.#phase = "discarded";
			this.#abort();
		}
	}
	cut(): void {
		if (this.#phase !== "open" && this.#phase !== "preparing") return;
		this.#phase = "cut";
		this.#abort();
		this.#release();
		this.#rejectQueued?.(this.#cutError());
	}
	settle(): void {
		for (const staged of this.#staged?.values() ?? []) {
			if (this.#phase === "committed") staged.committed();
			else staged.discarded();
		}
	}
	#abort(): void {
		for (const group of this.#entries.values())
			for (const entry of group.values()) entry.draft?.change.abort();
	}
	#slot(
		handle: SingletonHandle<JsonObject> | KeyedHandle<JsonObject>,
	): SingletonSlot | KeyedSlot {
		const { slot, version } = handle as Singleton | Keyed;
		slot.definition.assertVersion(version);
		return slot;
	}
	#entry(slot: DocumentSlot, key: string): Entry {
		this.#assertOpen();
		if (slot.owner !== this.documents)
			throw new Error(
				`${this.documents.label}: a transaction drafts only its own object's documents`,
			);
		let entries = this.#entries.get(slot);
		if (!entries) {
			entries = new Map();
			this.#entries.set(slot, entries);
		}
		let entry = entries.get(key);
		if (!entry) {
			entry = { slot, key, draft: undefined, retire: false, found: undefined };
			entries.set(key, entry);
		}
		return entry;
	}
	#assertOpen(): void {
		if (this.#phase === "open") return;
		if (this.#phase === "cut") throw this.#cutError();
		throw new Error(`${this.documents.label}: the transaction has settled`);
	}
	#cutError(): ObjectsError {
		return new ObjectsError({
			code: "released",
			reason: "discarded",
			message: `${this.documents.label}: the transaction was discarded at the seal`,
		});
	}
	#handle(table: object): TableHandle {
		this.#assertOpen();
		if (!(table instanceof TableHandle) || table.owner.scope !== this.documents)
			throw new Error(
				`${this.documents.label}: a transaction writes only its own object's tables`,
			);
		table.assertVersion();
		return table;
	}
	#changes(table: object): TableChanges {
		const handle = this.#handle(table);
		this.#tables ??= new Map();
		let changes = this.#tables.get(handle);
		if (!changes) {
			changes = new TableChanges(handle, this.stageStore(handle.store));
			this.#tables.set(handle, changes);
		}
		return changes;
	}
	async #track<T>(read: Promise<T>): Promise<T> {
		this.#pending++;
		try {
			return await read;
		} finally {
			this.#pending--;
		}
	}
}
