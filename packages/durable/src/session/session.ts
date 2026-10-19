import { type Context, type JsonValue, replicatedState } from "@axi/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, withoutAbortSignal } from "@axi/chord/context";
import { type Op, track } from "@axi/chord/delta";
import {
	addressId,
	checkRecordScope,
	checkRecordVersion,
	materializeDocument,
	resolveAddress,
	type AnyDocDefinition,
	type AnyDocToken,
} from "../documents.ts";
import { SessionFailed } from "../errors.ts";
import { idFromNumber } from "../ids.ts";
import type * as T from "../types.ts";
import { hostTimers, type Timers } from "../timers.ts";
import { CommittedStateSource, CommittedWatch, RETIREMENT_OPERATIONS } from "./observation.ts";
import { GuardedStorage } from "./storage.ts";
import { Transaction, type LoadedDocument, type TransactionHost, type TransactionScope } from "./transaction.ts";
let defaultRetention = 600_000;
export function setDefaultDocumentRetention(ms: number): void {
	defaultRetention = ms;
}
export function documentRetention(ms: number | undefined): number {
	return typeof ms === "number" && ms >= 0 ? ms : defaultRetention;
}
export function createSession(
	storage: T.Storage,
	options?: { readonly now?: () => number; readonly documentRetentionMs?: number; readonly setTimer?: T.SetTimer },
): T.Session {
	const retention = options?.documentRetentionMs;
	return new SessionImpl(storage, options?.now, () => retention, options?.setTimer);
}
type CommitListener = (publication: T.CommitPublication, context: Context) => void;
export class SessionImpl implements T.Session {
	readonly #backend: T.Storage;
	readonly #documents = new Map<string, LoadedDocument>();
	readonly #idle = new Map<string, number>();
	readonly #pins = new Map<T.DocumentId, number>();
	readonly #listeners = new Set<CommitListener>();
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
	#tail: Promise<void> = Promise.resolve();
	#sweep: { at: number; cancel?: () => void } | undefined;
	#sweeps = 0;
	#timersUnavailable = false;
	constructor(
		storage: T.Storage,
		now: () => number = Date.now,
		retention: () => number | undefined = () => undefined,
		setTimer?: T.SetTimer,
	) {
		this.#failed.promise.catch(() => {});
		this.#backend = new GuardedStorage(storage, this);
		this.#timers = hostTimers(setTimer, (error) => this.report(error, { type: "host_error", callback: "setTimer" }));
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
		this.#host = {
			storage: this.#backend,
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
	get documentCacheSizes() {
		return { cached: this.#documents.size, idle: this.#idle.size, attached: this.#pins.size, sweeps: this.#sweeps };
	}
	assertUsable(): void {
		this.#healthy();
		if (this.#closing) throw new Error("Session is closed");
	}
	#healthy(): void {
		if (this.#failure) throw new SessionFailed(this.#failure.error);
	}
	fail(error: unknown, context?: Context): void {
		if (this.#failure) return;
		this.#failure = { error };
		this.#failed.reject(new SessionFailed(error));
		this.close(BACKGROUND_CONTEXT).catch(() => {});
		this.report(error, { type: "session_failed" }, context);
	}
	report(_error: unknown, _info: T.ReportInfo = { type: "listener_error" }, _context?: Context): void {}
	protected writeAtClose(writes: () => readonly T.StorageWrite[]): Promise<void> {
		return this.#enqueue(async () => {
			if (this.#failure) return;
			const batch = writes();
			if (batch.length) await this.#backend.commit(batch, BACKGROUND_CONTEXT);
		});
	}
	protected conversationCreated(_tx: Transaction, _record: T.ConversationRecord): Promise<void> {
		return Promise.resolve();
	}
	protected beforeClose(): Promise<void> {
		return Promise.resolve();
	}
	commit<Value>(change: (tx: T.Tx) => Value | Promise<Value>, context: Context): Promise<Value> {
		return this.commitWith(change, context);
	}
	commitWith<Value>(
		change: (tx: Transaction) => Value | Promise<Value>,
		context: Context,
		scope?: TransactionScope,
	): Promise<Value> {
		try {
			this.assertUsable();
			return this.#enqueue(() => this.#commit(change, context, scope));
		} catch (error) {
			return Promise.reject(error);
		}
	}
	readOnLine<Value>(job: () => Promise<Value>): Promise<Value> {
		try {
			this.assertUsable();
			return this.#enqueue(() => {
				this.#healthy();
				return job();
			});
		} catch (error) {
			return Promise.reject(error);
		}
	}
	async #commit<Value>(
		change: (tx: Transaction) => Value | Promise<Value>,
		context: Context,
		scope?: TransactionScope,
	): Promise<Value> {
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
			return value;
		}
		let seq: T.Seq;
		try {
			seq = await this.#backend.commit(writes, withoutAbortSignal(context));
		} catch (error) {
			tx.discard();
			throw error;
		}
		let documents: T.DocumentCommitChange[];
		try {
			documents = tx.adopt(seq);
		} catch (error) {
			this.fail(error);
			throw error;
		}
		for (const document of documents) this.#touch(addressId(document.record));
		for (const write of writes) {
			if (write.type === "entry")
				context.telemetry.addEvent("axi.durable.entry", { "entry.id": write.value.id, "entry.kind": write.value.kind });
			else if (write.type === "submission" && (write.value.status === "done" || write.value.status === "unanswered")) {
				context.telemetry.addEvent("axi.durable.submission", {
					"submission.id": write.value.id,
					status: write.value.status,
					"answer.entry_id": write.value.answer,
				});
			}
		}
		if (this.#internal.size !== 0 || this.#listeners.size !== 0) {
			const changes: T.CommitChange[] = [];
			for (const write of writes)
				if (
					write.type === "conversation" ||
					write.type === "entry" ||
					write.type === "task" ||
					write.type === "submission"
				)
					changes.push(write);
			for (const document of documents) changes.push(document);
			const publication = { seq, changes };
			for (const listener of [...this.#internal])
				contained(
					() => listener(publication, context),
					(error) => this.fail(error, context),
				);
			for (const listener of [...this.#listeners])
				contained(
					() => listener(publication, context),
					(error) => this.report(error, { type: "listener_error" }, context),
				);
		}
		this.#evictExpired();
		return value;
	}
	subscribeCommits(listener: CommitListener): () => void {
		this.assertUsable();
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	observeCommits(listener: CommitListener): () => void {
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
	documentState<Value extends T.JsonObject>(
		token: T.SessionDocToken<Value>,
		context: Context,
	): Promise<T.DocumentState<Value> | undefined>;
	documentState<Value extends T.JsonObject, Seed extends JsonValue>(
		token: T.SessionDocFamilyToken<Value, Seed>,
		key: string,
		context: Context,
	): Promise<T.DocumentState<Value> | undefined>;
	documentState<Value extends T.JsonObject>(
		token: T.ConversationDocToken<Value>,
		conversationId: T.ConversationId,
		context: Context,
	): Promise<T.DocumentState<Value> | undefined>;
	documentState<Value extends T.JsonObject, Seed extends JsonValue>(
		token: T.ConversationDocFamilyToken<Value, Seed>,
		conversationId: T.ConversationId,
		key: string,
		context: Context,
	): Promise<T.DocumentState<Value> | undefined>;
	documentState<Value extends T.JsonObject>(
		token: T.TaskDocToken<Value>,
		taskId: T.TaskId,
		context: Context,
	): Promise<T.DocumentState<Value> | undefined>;
	documentState<Value extends T.JsonObject, Seed extends JsonValue>(
		token: T.TaskDocFamilyToken<Value, Seed>,
		taskId: T.TaskId,
		key: string,
		context: Context,
	): Promise<T.DocumentState<Value> | undefined>;
	documentState(token: AnyDocToken, ...args: readonly unknown[]): Promise<T.DocumentState<T.JsonObject> | undefined> {
		try {
			this.assertUsable();
			const definition = token.definition;
			const resolved = resolveAddress(definition, args);
			const context = args[resolved.nextArgument] as Context;
			return this.#enqueue(async () => {
				this.#healthy();
				const loaded = await this.#load(definition, resolved.id, resolved.address, context);
				if (!loaded) return undefined;
				const source = this.#attach(
					definition,
					loaded,
					(value, detach) => new CommittedStateSource<T.JsonObject | null>(value, detach),
				);
				try {
					return replicatedState(source.observer, { onError: (error) => this.report(error) });
				} catch (error) {
					source.detach();
					throw error;
				}
			});
		} catch (error) {
			return Promise.reject(error);
		}
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
		const signal = context.abortSignal;
		let cancelled = signal?.aborted === true;
		const abort = () => {
			cancelled = true;
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const watch = await this.#enqueue(async () => {
				this.#healthy();
				if (cancelled) throw cancellationError(signal!);
				const loaded = await this.#load(definition, resolved.id, resolved.address, context);
				if (cancelled) throw cancellationError(signal!);
				if (!loaded) return undefined;
				return this.#attach(
					definition,
					loaded,
					(value, detach) => new CommittedWatch<T.JsonObject | null>(value, detach, (error) => this.report(error)),
				).observer;
			});
			if (!watch) return undefined;
			if (cancelled) {
				watch.cancel();
				throw cancellationError(signal!);
			}
			if (signal) watch.observeCancellation(signal);
			return watch;
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
			const entry = await this.#backend.entry(conversationId, at, context);
			if (!entry) throw new Error(`Entry ${at} is not visible from conversation ${conversationId}`);
			const address = {
				...resolved.address,
				scope: { kind: "conversation" as const, conversationId: entry.entry.conversationId },
			};
			const record = await this.#backend.findDocument(address, entry.commitSeq, context);
			if (!record) return undefined;
			const stored = await this.#backend.document(record.id, entry.commitSeq, context);
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
					this.#enqueue(async () => {
						this.#listeners.clear();
						this.#internal.clear();
						this.#documents.clear();
						this.#idle.clear();
						this.#pins.clear();
						try {
							await this.#backend.close(cleanup);
						} catch (error) {
							if (!this.#failure) {
								this.#failure = { error };
								this.report(error, { type: "session_failed" });
							}
							throw error;
						}
					}),
				)
				.finally(() => {
					this.#closed.resolve(this.#failure ? { reason: "failed", error: this.#failure.error } : { reason: "closed" });
				});
			this.#sweep?.cancel?.();
			this.#sweep = undefined;
			const listeners = [...this.#closingListeners];
			this.#closingListeners.clear();
			for (const listener of listeners) contained(listener, (error) => this.report(error));
		}
		return awaitWithContext(this.#closing, context);
	}
	unloadDocuments(): Promise<void> {
		return this.#enqueue(async () => {
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
		const cached = this.#documents.get(identity);
		if (cached?.valueVersion === definition.version) {
			this.#touch(identity);
			return cached;
		}
		if (cached !== undefined) this.#drop(identity);
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
	#attach<Observer extends CommittedStateSource | CommittedWatch>(
		definition: AnyDocDefinition,
		loaded: LoadedDocument,
		create: (value: T.JsonObject, detach: () => void) => Observer,
	): { observer: Observer; detach: () => void } {
		checkRecordScope(definition, loaded.record);
		checkRecordVersion(definition, loaded.record, loaded.storedVersion);
		const unpin = this.#pin(loaded.addressId, loaded.record.id);
		let offCommit = () => {};
		let offClose = () => {};
		const detach = () => {
			offCommit();
			offClose();
			unpin();
		};
		let observer: Observer;
		try {
			observer = create(loaded.tracker.value, detach);
		} catch (error) {
			unpin();
			throw error;
		}
		let version = loaded.valueVersion;
		try {
			offCommit = this.observeCommits((publication, context) => {
				for (const change of publication.changes) {
					if (change.type !== "document" || change.record.id !== loaded.record.id) continue;
					let ops: readonly Op[];
					if (change.value === null) ops = RETIREMENT_OPERATIONS;
					else if (version === change.version) ops = change.ops;
					else {
						version = change.version!;
						ops = [["r", change.value]];
					}
					if (!ops.length) continue;
					if (change.value === null) unpin();
					observer.advance(
						change.value,
						ops,
						observer instanceof CommittedStateSource ? withoutAbortSignal(context) : context,
					);
				}
			});
			offClose = this.subscribeClose(() => observer.closeSession(this.#failure));
		} catch (error) {
			detach();
			throw error;
		}
		return { observer, detach };
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
			this.#drop(identity);
		}
		this.#scheduleSweep();
	}
	#scheduleSweep(): void {
		if (this.#closing) return;
		const oldest = this.#idle.values().next();
		if (oldest.done) return;
		const at = oldest.value + this.#retention();
		if (this.#sweep && this.#sweep.at <= at) return;
		this.#sweep?.cancel?.();
		const pending: { at: number; cancel?: () => void } = { at };
		this.#sweep = pending;
		const run = () => {
			this.#sweeps++;
			this.#enqueue(async () => {
				if (this.#sweep === pending) this.#sweep = undefined;
				if (!this.#closing) this.#evictExpired();
			}).catch(() => {});
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
		const result = this.#tail.then(job);
		this.#tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}
}
export function contained(callback: () => unknown, onError: (error: unknown) => void): void {
	try {
		const result = callback();
		if (
			result !== null &&
			(typeof result === "object" || typeof result === "function") &&
			typeof Reflect.get(result, "then") === "function"
		)
			Promise.resolve(result).catch(onError);
	} catch (error) {
		onError(error);
	}
}
function cancellationError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
