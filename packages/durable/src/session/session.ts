import { type Context } from "@axi/objects/context";
import { type JsonValue } from "@axi/objects/json";
import { Watch, type WatchEnd } from "@axi/objects/watch";
import { awaitWithContext, BACKGROUND_CONTEXT, withoutAbortSignal } from "@axi/objects/context";
import { track, PendingOps, type Op } from "@axi/objects/delta";
import {
	addressId,
	checkRecordScope,
	checkRecordVersion,
	materializeDocument,
	resolveAddress,
	type AnyDocDefinition,
	type AnyDocToken,
} from "../documents.ts";
import { ReadOnlySession, SessionFailed } from "../errors.ts";
import { idFromNumber } from "../ids.ts";
import type * as T from "../types.ts";
import { hostTimers, type Timers } from "../timers.ts";
import { GuardedStorage } from "./storage.ts";
import { CachedStorage } from "./cached-storage.ts";
import { ConversationTails, type HeadMarker } from "./conversation-tails.ts";
import { MutationLine, type Ran } from "./line.ts";
import { Writer, type PublishFailure } from "./writer.ts";
import { ALL_KEYS, GatedStorage, appendKey, conversationKey, documentKey, incarnationKey } from "./keys.ts";
import { GuardedObserver, contained } from "./observer.ts";
export { contained } from "./observer.ts";
import {
	Transaction,
	type LoadedDocument,
	type TransactionHost,
	type TransactionScope,
	type HeldDocument,
	type AdoptedDocuments,
	storeHeld,
} from "./transaction.ts";
let defaultRetention = 600_000;
const NO_VALUE_OPERATIONS: readonly Op[] = [];
export const NORMAL_END: WatchEnd = { kind: "ended" };
export function setDefaultDocumentRetention(ms: number): void {
	defaultRetention = ms;
}
export function documentRetention(ms: number | undefined): number {
	return typeof ms === "number" && ms >= 0 ? ms : defaultRetention;
}
export function createSession(
	storage: T.Storage,
	options?: {
		readonly now?: () => number;
		readonly documentRetentionMs?: number;
		readonly setTimer?: T.SetTimer;
		readonly persistWithinMs?: number;
	},
): T.Session {
	const retention = options?.documentRetentionMs;
	const window = options?.persistWithinMs;
	return new SessionImpl(
		storage,
		options?.now,
		() => retention,
		options?.setTimer,
		false,
		() => window,
	);
}
export type ObservedCommit =
	| (T.CommitPublication & { readonly kind: "stored" })
	| { readonly kind: "memory"; readonly changes: readonly T.DocumentCommitChange[] };
export function persistWithin(ms: number | undefined): number {
	return typeof ms === "number" && ms >= 0 ? ms : 1_000;
}
type Hold = HeldDocument & { deadline: number; release(): void };
type HoldTimer = { at: number; fired: boolean; cancel(): void };
type CommitListener = (publication: ObservedCommit, context: Context) => void;
export class SessionImpl implements T.Session {
	readonly #backend: T.Storage;
	readonly #cached: CachedStorage | undefined;
	readonly #gated: GatedStorage;
	readonly #writer: Writer;
	readonly #tails: ConversationTails | undefined;
	readonly #line = new MutationLine(() => this.#failure);
	readonly #taskDocuments = new Map<T.TaskId, Map<T.DocumentId, T.DocumentRecord>>();
	readonly #readOnly: boolean;
	readonly #holds = new Map<T.DocumentId, Hold>();
	readonly #persistWithin: () => number;
	#holdTimer: HoldTimer | undefined;
	readonly #documents = new Map<string, LoadedDocument>();
	readonly #idle = new Map<string, number>();
	readonly #pins = new Map<T.DocumentId, number>();
	readonly #listeners = new Set<GuardedObserver<T.CommitPublication>>();
	readonly #internal = new Set<CommitListener>();
	readonly #closingListeners = new Set<() => void>();
	readonly #host: TransactionHost;
	readonly #clock: () => number;
	readonly #retention: () => number;
	readonly #timers: Timers;
	readonly #failed = Promise.withResolvers<never>();
	readonly #closed = Promise.withResolvers<T.SessionEnd>();
	#failure: { readonly error: unknown } | undefined;
	#closing: Promise<void> | undefined;
	#sweep: { at: number; cancel?: () => void } | undefined;
	#sweeps = 0;
	#timersUnavailable = false;
	constructor(
		storage: T.Storage,
		now: () => number = Date.now,
		retention: () => number | undefined = () => undefined,
		setTimer?: T.SetTimer,
		readOnly = false,
		persist: () => number | undefined = () => undefined,
	) {
		this.#readOnly = readOnly;
		this.#failed.promise.catch(() => {});
		this.#cached = readOnly ? undefined : new CachedStorage(storage);
		this.#backend = new GuardedStorage(this.#cached ?? storage, this);
		this.#gated = new GatedStorage(this.#backend, (key) => this.touch(key));
		this.#tails = readOnly ? undefined : new ConversationTails();
		this.#writer = new Writer({
			commit: (...args) => this.#backend.commit(...args),
			stored: (writes) => {
				this.#cached?.published(writes);
				this.#tails?.apply(writes);
			},
			publishing: (publish, context) => this.#publishing(publish, context),
			failure: () => this.#failure,
			fail: (error, index, own) => this.fail(error, undefined, index, own),
			report: (error, context) => this.report(error, { kind: "listener_error" }, context),
		});
		this.#timers = hostTimers(setTimer, (error) => this.report(error, { kind: "host_error", callback: "setTimer" }));
		this.#clock = () => {
			try {
				return now();
			} catch {
				return Date.now();
			}
		};
		this.#retention = () => {
			try {
				return documentRetention(retention());
			} catch {
				return documentRetention(undefined);
			}
		};
		this.#persistWithin = () => {
			try {
				return persistWithin(persist());
			} catch {
				return persistWithin(undefined);
			}
		};
		this.#host = {
			storage: this.#gated,
			touch: (key) => this.touch(key),
			latestEntryId: (id, context) => this.latestEntryId(id, context),
			latestHeadMarker: (id, context) => this.latestHeadMarker(id, undefined, context),
			taskDocuments: (id) => this.#taskDocuments.get(id)?.values(),
			now,
			cached: (identity) => {
				const value = this.#documents.get(identity);
				if (value) this.#touch(identity);
				return value;
			},
			load: (definition, identity, address, context) => this.#load(definition, identity, address, context),
			install: (value) => {
				this.#documents.set(value.addressId, value);
				this.#touch(value.addressId);
			},
			evict: (identity, incarnation) => {
				if (this.#documents.get(identity)?.record.id === incarnation) this.#drop(identity);
			},
			conversationCreated: (tx, record) => this.conversationCreated(tx, record),
		};
	}
	get closed(): Promise<T.SessionEnd> {
		return this.#closed.promise;
	}
	get failed(): Promise<never> {
		return this.#failed.promise;
	}
	get failure(): { readonly error: unknown } | undefined {
		return this.#failure;
	}
	protected get storage(): T.Storage {
		return this.#backend;
	}
	get lineStorage(): T.Storage {
		return this.#gated;
	}
	get lineSizes() {
		return {
			outstanding: this.#line.outstanding,
			unpublished: this.#writer.unpublished,
			reads: this.#cached?.readsInFlight ?? 0,
		};
	}
	touch(key: string): Promise<void> | undefined {
		const gate = key === ALL_KEYS ? this.#writer.drained() : this.#writer.gate(key);
		if (gate === undefined) return undefined;
		if (this.#line.current !== undefined) this.#line.current.hit = true;
		return gate.then(() => this.#healthy());
	}
	onJobEnd(end: () => void): void {
		this.#line.onJobEnd(end);
	}
	latestEntryId(id: T.ConversationId, context: Context): Promise<T.EntryId | undefined> {
		const gate = this.#touchEntries(id);
		const read = async () =>
			(await this.#backend.scanEntries({ conversationId: id }, 1, undefined, context)).items[0]?.id;
		const latest = () => (this.#tails === undefined ? read() : this.#tails.latest(id, read));
		return gate === undefined ? latest() : gate.then(latest);
	}
	knownLatestEntryId(id: T.ConversationId): T.EntryId | null | undefined {
		return this.#tails?.peek(id);
	}
	latestHeadMarker(id: T.ConversationId, at: T.EntryId | undefined, context: Context): Promise<HeadMarker | undefined> {
		const gate = this.#touchEntries(id);
		const read = () => this.#backend.findLatestHeadMarker(id, at, context);
		const marker = () => (this.#tails === undefined ? read() : this.#tails.marker(id, at, read));
		return gate === undefined ? marker() : gate.then(marker);
	}
	#touchEntries(id: T.ConversationId): Promise<void> | undefined {
		const created = this.touch(conversationKey(id));
		const appended = this.touch(appendKey(id));
		if (created === undefined) return appended;
		return appended === undefined ? created : Promise.all([created, appended]).then(() => {});
	}
	get documentCacheSizes() {
		return {
			cached: this.#documents.size,
			idle: this.#idle.size,
			attached: this.#pins.size,
			sweeps: this.#sweeps,
			held: this.#holds.size,
			taskDocuments: this.#taskDocuments.size,
			tails: this.#tails?.size ?? 0,
		};
	}
	assertUsable(): void {
		this.#healthy();
		if (this.#closing) throw new Error("Session is closed");
	}
	#healthy(): void {
		if (this.#failure) throw new SessionFailed(this.#failure.error);
	}
	fail(error: unknown, context?: Context, at?: number, own: readonly number[] = []): void {
		if (this.#failure) return;
		this.#failure = { error };
		this.#line.fail(at, own);
		this.#failed.reject(new SessionFailed(error));
		this.close(BACKGROUND_CONTEXT).catch(() => {});
		this.report(error, { kind: "storage_failed" }, context);
	}
	report(_error: unknown, _info: T.ReportInfo = { kind: "listener_error" }, _context?: Context): void {}
	protected writeAtClose(writes: () => readonly T.StorageWrite[]): Promise<void> {
		return this.#line.maintain(async (index) => {
			await this.#drained();
			if (this.#failure !== undefined) return;
			const batch = writes();
			if (batch.length === 0) return;
			await this.#writer.admit({
				index,
				writes: batch,
				keys: [],
				context: BACKGROUND_CONTEXT,
				publish: () => undefined,
				discard: () => {},
			}).outcome;
		});
	}
	protected membershipKeys(_tx: Transaction): readonly string[] | Promise<readonly string[]> {
		return [];
	}
	protected conversationCreated(_tx: Transaction, _record: T.ConversationRecord): Promise<void> {
		return Promise.resolve();
	}
	protected beforeClose(): Promise<void> {
		return Promise.resolve();
	}
	commit<Value>(
		change: (tx: T.Tx) => Value | Promise<Value>,
		context: Context,
		options?: T.CommitOptions,
	): Promise<Value> {
		return this.commitWith(change, context, undefined, options);
	}
	commitWith<Value>(
		change: (tx: Transaction) => Value | Promise<Value>,
		context: Context,
		scope?: TransactionScope,
		options?: T.CommitOptions,
	): Promise<Value> {
		try {
			this.assertUsable();
			let within: number | undefined;
			const persistence = options?.persistence;
			if (persistence?.kind === "deferred") {
				const requested = persistence.withinMs;
				within = requested === undefined ? this.#persistWithin() : requested;
				if (typeof within !== "number" || !(within >= 0))
					throw new TypeError("CommitPersistence.withinMs must be a number of milliseconds, 0 or more");
			}
			return this.#line.enqueue((index) => this.#commit(change, context, scope, within, index));
		} catch (error) {
			return Promise.reject(error);
		}
	}
	ownsTransaction(tx: T.Tx): tx is Transaction {
		return Transaction.belongsTo(tx, this.#host);
	}
	commitInternal<Value>(change: (tx: Transaction) => Value | Promise<Value>, context: Context): Promise<Value> {
		try {
			this.assertUsable();
			return this.#line.enqueue((index) => this.#commit(change, context, undefined, undefined, index), true);
		} catch (error) {
			return Promise.reject(error);
		}
	}
	readOnLine<Value>(job: (storage: T.Storage) => Promise<Value>): Promise<Value> {
		try {
			this.assertUsable();
			return this.#line.enqueue(async () => {
				this.#healthy();
				return { value: await job(this.#gated) };
			});
		} catch (error) {
			return Promise.reject(error);
		}
	}
	async #commit<Value>(
		change: (tx: Transaction) => Value | Promise<Value>,
		context: Context,
		scope: TransactionScope | undefined,
		within: number | undefined,
		index: number,
	): Promise<Ran<Value>> {
		this.#healthy();
		context.abortSignal?.throwIfAborted();
		const tx = new Transaction(this.#host, context, scope);
		let value: Value;
		try {
			value = await change(tx);
			this.#healthy();
		} catch (error) {
			await tx.settleFailure();
			this.#evictExpired();
			throw error;
		}
		let writes: readonly T.StorageWrite[];
		try {
			writes = await tx.settleSuccess();
		} catch (error) {
			this.#evictExpired();
			throw error;
		}
		if (!writes.length) {
			tx.discard();
			this.#evictExpired();
			return { value };
		}
		if (this.#readOnly) {
			tx.discard();
			this.#evictExpired();
			throw new ReadOnlySession("a commit with writes");
		}
		if (within !== undefined) {
			// Only eligible documents can publish ahead of persistence. Record writes
			// still take the stored path, which also absorbs any held document changes.
			const candidates = tx.holdable();
			if (candidates !== undefined) {
				const part = this.#writer.admit({
					index,
					writes: undefined,
					keys: tx.writeKeys(),
					context,
					publish: () => this.#hold(tx, candidates, within, context),
					discard: () => tx.discard(),
				});
				this.#evictExpired();
				return { value, after: part.outcome };
			}
		}
		let membership = this.membershipKeys(tx);
		if (!Array.isArray(membership)) {
			try {
				membership = await membership;
			} catch (error) {
				tx.discard();
				this.#evictExpired();
				throw error;
			}
		}
		const taken = this.#holds.size === 0 ? [] : tx.takeHeld((id) => this.#holds.get(id));
		const keys = tx.writeKeys();
		keys.push(...membership);
		const part = this.#writer.admit({
			index,
			writes,
			keys,
			context,
			publish: (seq) => this.#adopt(tx, writes, taken, seq!, context),
			discard: () => tx.discard(),
		});
		this.#evictExpired();
		return { value, after: part.outcome };
	}
	#adopt(
		tx: Transaction,
		writes: readonly T.StorageWrite[],
		taken: readonly Hold[],
		seq: T.Seq,
		context: Context,
	): PublishFailure | undefined {
		let documents: AdoptedDocuments;
		try {
			documents = tx.adopt(seq);
		} catch (error) {
			return { kind: "adoption", error };
		}
		for (const id of tx.createdTaskIds()) this.#taskDocuments.set(id, new Map());
		for (const change of documents.stored) {
			if (change.type !== "document" || change.record.scope.kind !== "task") continue;
			const index = this.#taskDocuments.get(change.record.scope.taskId);
			if (change.kind === "retire") index?.delete(change.record.id);
			else if (change.record.createdAt === seq) index?.set(change.record.id, change.record);
		}
		for (const write of writes)
			if (write.type === "task" && write.value.state.status === "terminal") this.#taskDocuments.delete(write.value.id);
		const failure = this.#publish(seq, writes, documents, context);
		if (taken.length > 0) this.#releaseHeld(taken);
		for (const document of documents.stored) this.#touch(addressId(document.record));
		return failure === undefined ? undefined : { kind: "listener", error: failure.error };
	}
	#hold(
		tx: Transaction,
		candidates: NonNullable<ReturnType<Transaction["holdable"]>>,
		within: number,
		context: Context,
	): PublishFailure | undefined {
		let changes: T.DocumentCommitChange[];
		try {
			changes = tx.adoptHeld();
		} catch (error) {
			return { kind: "adoption", error };
		}
		const deadline = this.#clock() + within;
		for (const candidate of candidates) {
			const id = candidate.loaded.record.id;
			let hold = this.#holds.get(id);
			if (hold === undefined) {
				hold = {
					loaded: candidate.loaded,
					pending: new PendingOps(),
					base: false,
					deadline,
					release: this.#pin(candidate.loaded.addressId, id),
				};
				this.#holds.set(id, hold);
			}
			hold.pending.push(candidate.ops);
			hold.base ||= candidate.base;
			hold.deadline = Math.min(hold.deadline, deadline);
		}
		this.#schedulePersistence();
		let failure: PublishFailure | undefined;
		const publication: ObservedCommit = { kind: "memory", changes };
		for (const listener of [...this.#internal]) {
			try {
				listener(publication, context);
			} catch (error) {
				failure ??= { kind: "listener", error };
			}
		}
		return failure;
	}
	#publish(
		seq: T.Seq,
		writes: readonly T.StorageWrite[],
		documents: AdoptedDocuments,
		context: Context,
	): { error: unknown } | undefined {
		for (const write of writes) {
			try {
				if (write.type === "entry")
					context.telemetry.addEvent("axi.durable.entry", {
						"entry.id": write.value.id,
						"entry.kind": write.value.kind,
					});
				else if (write.type === "submission" && (write.value.status === "done" || write.value.status === "unanswered"))
					context.telemetry.addEvent("axi.durable.submission", {
						"submission.id": write.value.id,
						status: write.value.status,
						"answer.entry_id": write.value.answer,
					});
			} catch (error) {
				this.report(error, { kind: "host_error", callback: "telemetry" }, context);
			}
		}
		if (this.#listeners.size === 0 && this.#internal.size === 0) return;
		const changes: T.CommitChange[] = writes.filter(
			(write): write is T.TableCommitChange =>
				write.type === "conversation" || write.type === "entry" || write.type === "task" || write.type === "submission",
		);
		const tableCount = changes.length;
		changes.push(...documents.observed);
		const publication: ObservedCommit = { kind: "stored", seq, changes };
		if (this.#listeners.size > 0)
			this.#notifyStored(
				documents.stored === documents.observed
					? publication
					: { seq, changes: [...changes.slice(0, tableCount), ...documents.stored] },
				context,
			);
		let failure: { error: unknown } | undefined;
		for (const listener of [...this.#internal]) {
			try {
				listener(publication, context);
			} catch (error) {
				failure ??= { error };
			}
		}
		return failure;
	}
	#notifyStored(publication: T.CommitPublication, context: Context): void {
		void Promise.resolve().then(() => {
			for (const observer of [...this.#listeners]) observer.advance(publication, context);
		});
	}
	#releaseHeld(holds: readonly Hold[]): void {
		for (const hold of holds) {
			this.#holds.delete(hold.loaded.record.id);
			hold.release();
		}
		this.#schedulePersistence();
	}
	async #storeHeld(select: () => readonly Hold[], context: Context): Promise<void> {
		await this.#drained();
		const holds = select();
		if (holds.length === 0) return;
		const writes: Extract<T.StorageWrite, { type: "document.change" }>[] = [];
		const changes: T.DocumentCommitChange[] = [];
		const keys: string[] = [];
		for (const hold of holds) {
			const { record, tracker, valueVersion: version } = hold.loaded;
			const value = tracker.value;
			const combined = storeHeld(hold, NO_VALUE_OPERATIONS, value, version);
			writes.push({ type: "document.change", id: record.id, content: combined.content });
			keys.push(documentKey(hold.loaded.addressId), incarnationKey(record.id));
			changes.push({
				type: "document",
				kind: "change",
				record,
				conversationId: record.scope.kind === "conversation" ? record.scope.conversationId : undefined,
				version,
				value,
				ops: combined.ops,
			});
		}
		await this.#writer.admit({
			index: this.#line.current!.index,
			writes,
			keys,
			context,
			discard: () => {},
			publish: (seq) => {
				for (const [index, hold] of holds.entries())
					hold.loaded.deltasSinceBase = writes[index].content.kind === "base" ? 0 : hold.loaded.deltasSinceBase + 1;
				if (this.#listeners.size > 0) this.#notifyStored({ seq: seq!, changes }, context);
				this.#releaseHeld(holds);
				return undefined;
			},
		}).outcome;
	}
	#schedulePersistence(): void {
		if (this.#closing !== undefined) return;
		let at = Infinity;
		for (const hold of this.#holds.values()) at = Math.min(at, hold.deadline);
		if (this.#holdTimer !== undefined && (this.#holdTimer.fired || this.#holdTimer.at === at)) return;
		this.#holdTimer?.cancel();
		this.#holdTimer = undefined;
		if (at === Infinity) return;
		const timer: HoldTimer = { at, fired: false, cancel: () => {} };
		this.#holdTimer = timer;
		timer.cancel = this.#timers.foreground(
			() => {
				timer.fired = true;
				this.#line
					.maintain(async () => {
						if (this.#holdTimer === timer) this.#holdTimer = undefined;
						if (this.#closing === undefined && this.#failure === undefined)
							await this.#storeHeld(() => [...this.#holds.values()], BACKGROUND_CONTEXT);
					})
					.catch(() => {});
			},
			Math.max(0, at - this.#clock()),
		);
	}
	observeCommits(observer: T.CommitObserver): T.CommitObservation {
		this.assertUsable();
		const guarded = new GuardedObserver(
			observer,
			() => {
				this.#listeners.delete(guarded);
			},
			(error, context) => this.report(error, undefined, context),
		);
		this.#listeners.add(guarded);
		return detachedObservation(guarded);
	}
	followCommits(listener: CommitListener): () => void {
		this.assertUsable();
		this.#internal.add(listener);
		return () => this.#internal.delete(listener);
	}
	subscribeClose(listener: () => void): () => void {
		this.assertUsable();
		this.#closingListeners.add(listener);
		return () => this.#closingListeners.delete(listener);
	}
	async conversationDocumentOnLine(
		token: T.ConversationDocToken<T.JsonObject>,
		conversationId: T.ConversationId,
		context: Context,
	) {
		const definition = token.definition;
		const resolved = resolveAddress(definition, [conversationId, context]);
		const loaded = await this.#load(definition, resolved.id, resolved.address, context);
		if (!loaded) return undefined;
		checkRecordScope(definition, loaded.record);
		checkRecordVersion(definition, loaded.record, loaded.storedVersion);
		return { record: loaded.record, version: loaded.valueVersion, value: loaded.tracker.value };
	}
	snapshot<Value extends T.JsonObject>(
		token: T.SessionDocToken<Value>,
		context: Context,
	): Promise<Readonly<Value> | undefined>;
	snapshot<Value extends T.JsonObject, Seed extends JsonValue>(
		token: T.SessionDocFamilyToken<Value, Seed>,
		key: string,
		context: Context,
	): Promise<Readonly<Value> | undefined>;
	snapshot<Value extends T.JsonObject>(
		token: T.ConversationDocToken<Value>,
		conversationId: T.ConversationId,
		context: Context,
	): Promise<Readonly<Value> | undefined>;
	snapshot<Value extends T.JsonObject, Seed extends JsonValue>(
		token: T.ConversationDocFamilyToken<Value, Seed>,
		conversationId: T.ConversationId,
		key: string,
		context: Context,
	): Promise<Readonly<Value> | undefined>;
	snapshot<Value extends T.JsonObject>(
		token: T.TaskDocToken<Value>,
		taskId: T.TaskId,
		context: Context,
	): Promise<Readonly<Value> | undefined>;
	snapshot<Value extends T.JsonObject, Seed extends JsonValue>(
		token: T.TaskDocFamilyToken<Value, Seed>,
		taskId: T.TaskId,
		key: string,
		context: Context,
	): Promise<Readonly<Value> | undefined>;
	async snapshot(token: AnyDocToken, ...args: readonly unknown[]): Promise<T.JsonObject | undefined> {
		this.assertUsable();
		const definition = token.definition;
		const resolved = resolveAddress(definition, args);
		const context = args[resolved.nextArgument] as Context;
		const cached = this.#documents.get(resolved.id);
		let loaded: LoadedDocument | undefined;
		if (cached?.valueVersion === definition.version) {
			loaded = cached;
			this.#touch(resolved.id);
		} else
			loaded = await this.#enqueue(() => {
				this.#healthy();
				return this.#load(definition, resolved.id, resolved.address, context);
			});
		if (!loaded) return undefined;
		checkRecordScope(definition, loaded.record);
		checkRecordVersion(definition, loaded.record, loaded.storedVersion);
		return loaded.tracker.value;
	}
	watchDoc<Value extends T.JsonObject>(
		token: T.SessionDocToken<Value>,
		context: Context,
	): Promise<T.DocumentWatch<Value> | undefined>;
	watchDoc<Value extends T.JsonObject, Seed extends JsonValue>(
		token: T.SessionDocFamilyToken<Value, Seed>,
		key: string,
		context: Context,
	): Promise<T.DocumentWatch<Value> | undefined>;
	watchDoc<Value extends T.JsonObject>(
		token: T.ConversationDocToken<Value>,
		conversationId: T.ConversationId,
		context: Context,
	): Promise<T.DocumentWatch<Value> | undefined>;
	watchDoc<Value extends T.JsonObject, Seed extends JsonValue>(
		token: T.ConversationDocFamilyToken<Value, Seed>,
		conversationId: T.ConversationId,
		key: string,
		context: Context,
	): Promise<T.DocumentWatch<Value> | undefined>;
	watchDoc<Value extends T.JsonObject>(
		token: T.TaskDocToken<Value>,
		taskId: T.TaskId,
		context: Context,
	): Promise<T.DocumentWatch<Value> | undefined>;
	watchDoc<Value extends T.JsonObject, Seed extends JsonValue>(
		token: T.TaskDocFamilyToken<Value, Seed>,
		taskId: T.TaskId,
		key: string,
		context: Context,
	): Promise<T.DocumentWatch<Value> | undefined>;
	async watchDoc(token: AnyDocToken, ...args: readonly unknown[]): Promise<T.DocumentWatch<T.JsonObject> | undefined> {
		this.assertUsable();
		const definition = token.definition;
		const resolved = resolveAddress(definition, args);
		const context = args[resolved.nextArgument] as Context;
		return this.#acquire(
			definition,
			resolved,
			context,
			(loaded) => {
				const watch = this.#attach(definition, loaded, makeWatch, (watch) => watch.endAfterDelivery());
				if (context.abortSignal !== undefined) watch.observeAbort(context.abortSignal);
				return watch;
			},
			(watch) => watch.abort(),
		);
	}
	observeDoc<Value extends T.JsonObject>(
		token: T.SessionDocToken<Value>,
		observer: T.Observer<Readonly<Value>>,
		context: Context,
	): Promise<T.Observation<Readonly<Value>> | undefined>;
	observeDoc<Value extends T.JsonObject, Seed extends JsonValue>(
		token: T.SessionDocFamilyToken<Value, Seed>,
		key: string,
		observer: T.Observer<Readonly<Value>>,
		context: Context,
	): Promise<T.Observation<Readonly<Value>> | undefined>;
	observeDoc<Value extends T.JsonObject>(
		token: T.ConversationDocToken<Value>,
		conversationId: T.ConversationId,
		observer: T.Observer<Readonly<Value>>,
		context: Context,
	): Promise<T.Observation<Readonly<Value>> | undefined>;
	observeDoc<Value extends T.JsonObject, Seed extends JsonValue>(
		token: T.ConversationDocFamilyToken<Value, Seed>,
		conversationId: T.ConversationId,
		key: string,
		observer: T.Observer<Readonly<Value>>,
		context: Context,
	): Promise<T.Observation<Readonly<Value>> | undefined>;
	observeDoc<Value extends T.JsonObject>(
		token: T.TaskDocToken<Value>,
		taskId: T.TaskId,
		observer: T.Observer<Readonly<Value>>,
		context: Context,
	): Promise<T.Observation<Readonly<Value>> | undefined>;
	observeDoc<Value extends T.JsonObject, Seed extends JsonValue>(
		token: T.TaskDocFamilyToken<Value, Seed>,
		taskId: T.TaskId,
		key: string,
		observer: T.Observer<Readonly<Value>>,
		context: Context,
	): Promise<T.Observation<Readonly<Value>> | undefined>;
	async observeDoc(
		token: AnyDocToken,
		...args: readonly unknown[]
	): Promise<T.Observation<Readonly<T.JsonObject>> | undefined> {
		this.assertUsable();
		const definition = token.definition;
		const resolved = resolveAddress(definition, args);
		const target = args[resolved.nextArgument] as T.Observer<Readonly<T.JsonObject>>;
		const context = args[resolved.nextArgument + 1] as Context;
		return this.#acquire(
			definition,
			resolved,
			context,
			(loaded) => {
				const observer = this.#attach(
					definition,
					loaded,
					(_value, detach, report) => new GuardedObserver(target, detach, report),
					(observer) => observer.end(NORMAL_END),
				);
				return valueObservation(loaded.tracker.value, observer);
			},
			(observation) => observation.detach(),
		);
	}
	async #acquire<Value>(
		definition: AnyDocDefinition,
		resolved: { id: string; address: T.DocumentAddress },
		context: Context,
		create: (loaded: LoadedDocument) => Value,
		discard: (value: Value) => void,
	): Promise<Value | undefined> {
		const signal = context.abortSignal;
		let aborted = signal?.aborted === true;
		const abort = () => {
			aborted = true;
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const attached = await this.#enqueue(async () => {
				this.#healthy();
				if (aborted) throw cancellationError(signal!);
				const loaded = await this.#load(definition, resolved.id, resolved.address, context);
				if (aborted) throw cancellationError(signal!);
				return loaded === undefined ? undefined : create(loaded);
			});
			if (attached !== undefined && aborted) {
				discard(attached);
				throw cancellationError(signal!);
			}
			return attached;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}
	snapshotAsOf<Value extends T.JsonObject>(
		token: T.RewindableConversationDocToken<Value>,
		conversationId: T.ConversationId,
		at: T.EntryId,
		context: Context,
	): Promise<Readonly<Value> | undefined>;
	snapshotAsOf<Value extends T.JsonObject, Seed extends JsonValue>(
		token: T.RewindableConversationDocFamilyToken<Value, Seed>,
		conversationId: T.ConversationId,
		key: string,
		at: T.EntryId,
		context: Context,
	): Promise<Readonly<Value> | undefined>;
	async snapshotAsOf(token: AnyDocToken, ...args: readonly unknown[]): Promise<T.JsonObject | undefined> {
		this.assertUsable();
		const definition = token.definition;
		const resolved = resolveAddress(definition, args);
		if (resolved.address.scope.kind !== "conversation")
			throw new TypeError("Session.snapshotAsOf() requires a conversation document");
		const conversationId = resolved.address.scope.conversationId;
		const number = args[resolved.nextArgument];
		if (typeof number !== "number" || !Number.isSafeInteger(number))
			throw new TypeError("Session.snapshotAsOf() requires an entry ID");
		const at = idFromNumber<T.EntryId>(number);
		const context = args[resolved.nextArgument + 1] as Context;
		return this.#enqueue(async () => {
			this.#healthy();
			const entry = await this.#gated.entry(conversationId, at, context);
			if (!entry) throw new Error(`Entry ${at} is not visible from conversation ${conversationId}`);
			const address = {
				...resolved.address,
				scope: { kind: "conversation" as const, conversationId: entry.entry.conversationId },
			};
			const record = await this.#gated.findDocument(address, entry.commitSeq, context);
			if (!record) return undefined;
			const stored = await this.#gated.document(record.id, entry.commitSeq, context);
			if (!stored) throw new Error(`Historical document ${record.id} (${record.kind}) cannot be read`);
			return materializeDocument(definition, stored);
		});
	}
	close(context: Context): Promise<void> {
		if (!this.#closing) {
			const cleanup = withoutAbortSignal(context);
			this.#closing = Promise.resolve()
				.then(() => this.beforeClose())
				.then(() =>
					this.#line.maintain(async () => {
						await this.#drained();
						let storeFailure: { error: unknown } | undefined;
						if (this.#failure === undefined && this.#holds.size > 0)
							await this.#storeHeld(() => [...this.#holds.values()], cleanup).catch((error: unknown) => {
								storeFailure = { error };
							});
						const end = sessionObserverEnd(this.#failure);
						for (const observer of [...this.#listeners]) observer.end(end);
						this.#listeners.clear();
						this.#internal.clear();
						this.#documents.clear();
						this.#idle.clear();
						this.#pins.clear();
						this.#holds.clear();
						this.#taskDocuments.clear();
						try {
							await this.#backend.close(cleanup);
						} catch (error) {
							if (!this.#failure) {
								this.#failure = { error };
								this.report(error, { kind: "storage_failed" });
							}
							throw error;
						}
						if (storeFailure !== undefined) throw storeFailure.error;
					}),
				)
				.finally(() => {
					this.#closed.resolve(this.#failure ? { kind: "failed", error: this.#failure.error } : { kind: "closed" });
				});
			this.#sweep?.cancel?.();
			this.#sweep = undefined;
			this.#holdTimer?.cancel();
			this.#holdTimer = undefined;
			const listeners = [...this.#closingListeners];
			this.#closingListeners.clear();
			for (const listener of listeners) contained(listener, (error) => this.report(error));
		}
		return awaitWithContext(this.#closing, context);
	}
	unloadDocuments(): Promise<void> {
		return this.#line.maintain(async () => {
			if (this.#failure === undefined) await this.#storeHeld(() => [...this.#holds.values()], BACKGROUND_CONTEXT);
			this.#documents.clear();
			this.#idle.clear();
		});
	}
	async #load(
		definition: AnyDocDefinition,
		identity: string,
		address: T.DocumentAddress,
		context: Context,
	): Promise<LoadedDocument | undefined> {
		const gate = this.touch(documentKey(identity));
		if (gate !== undefined) await gate;
		const cached = this.#documents.get(identity);
		if (cached?.valueVersion === definition.version) {
			this.#touch(identity);
			return cached;
		}
		if (cached !== undefined) {
			const id = cached.record.id;
			await this.#storeHeld(() => {
				const hold = this.#holds.get(id);
				return hold === undefined ? [] : [hold];
			}, context);
			this.#drop(identity);
		}
		const record = await this.#backend.findDocument(address, "current", context);
		if (!record) return undefined;
		const stored = await this.#backend.document(record.id, "current", context);
		if (!stored) throw new Error(`Current document ${record.id} (${record.kind}) cannot be read`);
		const value = materializeDocument(definition, stored);
		const loaded: LoadedDocument = {
			addressId: identity,
			record: stored.record,
			storedVersion: stored.version,
			valueVersion: definition.version,
			deltasSinceBase: stored.deltasSinceBase,
			tracker: track(value),
		};
		this.#documents.set(identity, loaded);
		this.#touch(identity);
		return loaded;
	}
	#attach<Observer extends T.Observer<Readonly<T.JsonObject>>>(
		definition: AnyDocDefinition,
		loaded: LoadedDocument,
		create: (value: T.JsonObject, detach: () => void, report: (error: unknown) => void) => Observer,
		ownerEnded: (observer: Observer) => void,
	): Observer {
		checkRecordScope(definition, loaded.record);
		checkRecordVersion(definition, loaded.record, loaded.storedVersion);
		const identity = loaded.addressId;
		const address = loaded.record;
		let current: { id: T.DocumentId; version: number; value: Readonly<T.JsonObject> } | undefined = {
			id: loaded.record.id,
			version: loaded.valueVersion,
			value: loaded.tracker.value,
		};
		let release = this.#pin(identity, loaded.record.id);
		let offCommit = () => {};
		let offClose = () => {};
		let attached = true;
		const detach = () => {
			if (!attached) return;
			attached = false;
			offCommit();
			offClose();
			release();
		};
		const observer = create(loaded.tracker.value, detach, (error) => this.report(error));
		offCommit = this.followCommits((publication, context) => {
			if (!attached) return;
			let terminal = false;
			for (const change of publication.changes) {
				if (change.type === "task") {
					if (
						address.scope.kind === "task" &&
						change.value.id === address.scope.taskId &&
						change.value.state.status === "terminal"
					)
						terminal = true;
					continue;
				}
				if (change.type !== "document" || (change.record.id !== current?.id && addressId(change.record) !== identity))
					continue;
				if (change.kind === "retire") {
					if (change.record.id !== current?.id) continue;
					const value = current.value;
					current = undefined;
					release();
					observer.advance({ kind: "value", value, ops: NO_VALUE_OPERATIONS, retired: true }, context);
				} else if (change.record.id !== current?.id || change.version !== current.version) {
					if (change.record.id !== current?.id) {
						release();
						release = this.#pin(identity, change.record.id);
					}
					current = { id: change.record.id, version: change.version!, value: change.value };
					observer.advance({ kind: "value", value: change.value, ops: [["r", change.value]], retired: false }, context);
				} else if (change.ops.length > 0) {
					current = { ...current, value: change.value };
					observer.advance({ kind: "value", value: change.value, ops: change.ops, retired: false }, context);
				}
				if (!attached) return;
			}
			if (terminal) {
				offCommit();
				release();
				ownerEnded(observer);
			}
		});
		offClose = this.subscribeClose(() => {
			detach();
			observer.end(
				observer instanceof Watch && this.#failure === undefined
					? NORMAL_END
					: sessionObserverEnd(this.#failure),
			);
		});
		return observer;
	}
	#pin(identity: string, incarnation: T.DocumentId): () => void {
		this.#pins.set(incarnation, (this.#pins.get(incarnation) ?? 0) + 1);
		this.#idle.delete(identity);
		let pinned = true;
		return () => {
			if (!pinned) return;
			pinned = false;
			const count = (this.#pins.get(incarnation) ?? 1) - 1;
			if (count) this.#pins.set(incarnation, count);
			else {
				this.#pins.delete(incarnation);
				if (this.#documents.get(identity)?.record.id === incarnation) this.#touch(identity);
			}
		};
	}
	#touch(identity: string): void {
		const loaded = this.#documents.get(identity);
		if (!loaded || this.#pins.has(loaded.record.id)) return;
		const now = this.#clock();
		const last = this.#idle.get(identity);
		if (last !== undefined && now - last < Math.min(1_000, this.#retention() / 10)) return;
		this.#idle.delete(identity);
		this.#idle.set(identity, now);
		if (!this.#sweep || this.#sweep.at > now + this.#retention()) this.#scheduleSweep();
	}
	#drop(identity: string): void {
		this.#documents.delete(identity);
		this.#idle.delete(identity);
	}
	#evictExpired(): void {
		const expired = this.#clock() - this.#retention();
		for (const [identity, last] of this.#idle) {
			if (last > expired) break;
			if (this.#writer.gate(documentKey(identity)) !== undefined) continue;
			this.#drop(identity);
		}
		this.#scheduleSweep();
	}
	#scheduleSweep(): void {
		if (this.#closing) return;
		let oldest: number | undefined;
		for (const [identity, since] of this.#idle) {
			if (this.#writer.gate(documentKey(identity)) === undefined) {
				oldest = since;
				break;
			}
		}
		if (oldest === undefined) return;
		const at = oldest + this.#retention();
		if (this.#sweep && this.#sweep.at <= at) return;
		this.#sweep?.cancel?.();
		const pending: { at: number; cancel?: () => void } = { at };
		this.#sweep = pending;
		const run = () => {
			this.#sweeps++;
			this.#line
				.maintain(async () => {
					if (this.#sweep === pending) this.#sweep = undefined;
					if (!this.#closing) this.#evictExpired();
				})
				.catch(() => {});
		};
		const delay = at - this.#clock();
		if (delay <= 0) {
			queueMicrotask(run);
			return;
		}
		if (this.#timersUnavailable) {
			this.#sweep = undefined;
			return;
		}
		const cancel = this.#timers.background(run, delay);
		if (cancel === undefined) {
			this.#timersUnavailable = true;
			this.#sweep = undefined;
		} else pending.cancel = cancel;
	}
	#enqueue<Value>(job: () => Promise<Value>): Promise<Value> {
		return this.#line.enqueue(async () => ({ value: await job() }));
	}
	async #drained(): Promise<void> {
		const gate = this.#writer.drained();
		if (gate !== undefined) await gate;
	}
	#publishing(publish: () => void, context: Context): Promise<void> | undefined {
		const scope = this.#backend.publishing;
		if (scope === undefined) {
			publish();
			return undefined;
		}
		const done = Promise.withResolvers<void>();
		// A backend can defer publication to its own notification scope. A repeated
		// or late callback must not adopt the same revision twice.
		let ran = false;
		const once = () => {
			if (ran) return;
			ran = true;
			try {
				publish();
			} finally {
				done.resolve();
			}
		};
		try {
			scope(once, context);
		} catch (error) {
			this.report(error, { kind: "listener_error" }, context);
			once();
		}
		return done.promise;
	}
}
function cancellationError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

function detachedObservation(observer: { detach(): void }): T.CommitObservation {
	return { detach: () => observer.detach() };
}
function valueObservation<Value>(value: Value, observer: { detach(): void }): T.Observation<Value> {
	return { value, detach: () => observer.detach() };
}
function makeWatch(
	value: T.JsonObject,
	detach: () => void,
	report: (error: unknown) => void,
): Watch<Readonly<T.JsonObject>> {
	return new Watch(value, detach, report);
}
export function sessionObserverEnd(failure: { error: unknown } | undefined): WatchEnd {
	return { kind: "failed", error: failure === undefined ? new Error("session closed") : failure.error };
}
