import type { Context } from "../context/index.ts";
import { applyBatch } from "../store/apply-batch.ts";
import type { Backend } from "../store/backend.ts";
import { importStore } from "../store/import.ts";
import type { OutboxCommit } from "../store/outbox.ts";
import { openStore, type ObjectsStore, type Store } from "../store/store.ts";
import { decodeBatchLines, decodeSnapshot, encodeBatch, encodeSnapshot, type SyncBody } from "./batch.ts";
import {
	HistoryUnavailableError,
	LOG_START,
	remoteHead,
	remoteHistory,
	type Seq,
	type SessionSyncMaintenance,
	type SessionSyncStore,
} from "./remote.ts";

export const BATCH_BYTES = 8 * 1024 * 1024;
export const APPLY_BYTES = 4 * 1024 * 1024;
export type SyncState = { readonly syncedHead: Seq | undefined; readonly pulling?: Seq };
export interface SyncStateStore {
	get(sessionId: string, context: Context): Promise<SyncState | undefined>;
	set(sessionId: string, state: SyncState, context: Context): Promise<void>;
}
export type UploadResult =
	| { readonly type: "uploaded"; readonly head: Seq }
	| { readonly type: "idle" }
	| { readonly type: "diverged"; readonly at: Seq }
	| { readonly type: "behind"; readonly head: Seq; readonly syncedHead: Seq }
	| { readonly type: "stale_epoch"; readonly at: Seq; readonly epoch: number };
export type LocalCopy =
	| { readonly kind: "store"; readonly store: Store }
	| { readonly kind: "empty"; readonly backend: Backend };
export class OutboxUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OutboxUnavailableError";
	}
}
export class UnsyncedCommitsError extends Error {
	constructor(sessionId: string, localHead: Seq, syncedHead: Seq) {
		super(`This copy of session ${sessionId} is at ${localHead}, past what it shares with the remote (${syncedHead})`);
		this.name = "UnsyncedCommitsError";
	}
}
export function storeHead(store: Store): Seq {
	return store.lastSeq;
}
function outbox(store: Store) {
	if (!store.outbox)
		throw new OutboxUnavailableError("The session's store has no outbox: open it with { outbox: true } to sync it");
	return store.outbox;
}
function shared(state: SyncState | undefined, local: Seq): Seq {
	return state?.pulling !== undefined && local <= state.pulling ? local : (state?.syncedHead ?? LOG_START);
}
export async function readOutbox(store: Store, after: Seq, limit: number, context: Context): Promise<OutboxCommit[]> {
	const history = outbox(store);
	if (after < history.floor)
		throw new OutboxUnavailableError(`The outbox starts after ${history.floor}, past the synced head ${after}`);
	return history.read(after, limit, context);
}
const size = (commit: OutboxCommit) => JSON.stringify(commit.writes).length + 64;
async function* pages(store: Store, after: Seq, context: Context): AsyncGenerator<OutboxCommit[]> {
	let limit = 100;
	for (;;) {
		const page = await readOutbox(store, after, limit, context);
		if (!page.length) return;
		const lastPage = page.length < limit;
		after = page.at(-1)!.seq;
		limit = Math.max(
			1,
			Math.min(100, Math.floor((1_048_576 * page.length) / page.reduce((sum, commit) => sum + size(commit), 0))),
		);
		yield page;
		if (lastPage) return;
	}
}
async function endOfBatch(store: Store, after: Seq, context: Context): Promise<Seq | undefined> {
	let end: Seq | undefined,
		bytes = 0;
	for await (const page of pages(store, after, context)) {
		for (const commit of page) {
			const length = size(commit);
			if (end !== undefined && bytes + length > BATCH_BYTES) return end;
			end = commit.seq;
			bytes += length;
		}
		if (bytes >= BATCH_BYTES) break;
	}
	return end;
}
async function* commitsThrough(store: Store, after: Seq, end: Seq, context: Context): AsyncGenerator<OutboxCommit> {
	let reached = after;
	for await (const page of pages(store, after, context)) {
		for (const commit of page) {
			if (commit.seq > end) return;
			yield commit;
			reached = commit.seq;
		}
		if (reached >= end) return;
	}
	if (reached < end) throw new OutboxUnavailableError(`The outbox ends at ${reached}, before ${end}`);
}
async function snapshot(store: Store, context: Context): Promise<{ to: Seq; body: SyncBody; close(): Promise<void> }> {
	const parts = store.export(context);
	const first = await parts.next();
	if (first.done || first.value.kind !== "manifest") {
		await parts.return?.();
		throw new Error("A store export does not start with its manifest");
	}
	const manifest = first.value;
	return {
		to: manifest.lastSeq,
		body: encodeSnapshot(
			(async function* () {
				yield manifest;
				yield* parts;
			})(),
		),
		async close() {
			await parts.return?.();
		},
	};
}
export async function uploadSession(options: {
	readonly sessionId: string;
	readonly device: string;
	readonly source: Store;
	readonly store: SessionSyncStore;
	readonly state: SyncStateStore;
	readonly epoch?: number;
	readonly context: Context;
}): Promise<UploadResult> {
	const { source, store, state, sessionId, device, epoch, context } = options;
	const history = outbox(source);
	let synced = shared(await state.get(sessionId, context), source.lastSeq);
	let uploaded: Seq | undefined;
	for (;;) {
		if (source.lastSeq < synced) return { type: "behind", head: source.lastSeq, syncedHead: synced };
		const archive = synced === LOG_START && history.floor > 0;
		const exported = archive ? await snapshot(source, context) : undefined;
		const to = exported?.to ?? (await endOfBatch(source, synced, context));
		if (to === undefined) return uploaded === undefined ? { type: "idle" } : { type: "uploaded", head: uploaded };
		const body = exported?.body ?? encodeBatch(commitsThrough(source, synced, to, context));
		let result;
		try {
			result = await store.putBatch(sessionId, synced, to, device, body, context, {
				...(archive ? { archive: true } : {}),
				...(epoch === undefined ? {} : { epoch }),
			});
		} finally {
			await exported?.close();
		}
		if (result.type === "stale_epoch") return { type: "stale_epoch", at: synced, epoch: result.epoch };
		if (result.type === "not_head" || (result.type === "exists" && result.device !== device))
			return { type: "diverged", at: synced };
		synced = result.type === "created" ? to : result.to;
		await state.set(sessionId, { syncedHead: synced }, context);
		const trim = Math.min(synced, source.lastSeq);
		if (trim > history.floor) await history.trim(trim, context);
		if (result.type === "created") uploaded = to;
	}
}
async function applyBody(store: Store, body: SyncBody, context: Context): Promise<void> {
	let commits: OutboxCommit[] = [],
		bytes = 0;
	const flush = async () => {
		if (!commits.length) return;
		await applyBatch(store as ObjectsStore, commits, context);
		commits = [];
		bytes = 0;
	};
	for await (const line of decodeBatchLines(body)) {
		if (line.commit.seq <= store.lastSeq) continue;
		commits.push(line.commit);
		bytes += line.bytes;
		if (bytes >= APPLY_BYTES) await flush();
	}
	await flush();
}
export async function pullSession(options: {
	readonly sessionId: string;
	readonly store: SessionSyncStore;
	readonly local: LocalCopy;
	readonly state: SyncStateStore;
	readonly context: Context;
}): Promise<{ readonly store: Store; readonly head: Seq }> {
	const { sessionId, store: remote, local, state, context } = options;
	const listing = await remote.list(sessionId, context);
	let target = local.kind === "store" ? local.store : undefined;
	const at = () => target?.lastSeq ?? LOG_START;
	const synced = shared(await state.get(sessionId, context), at());
	if (at() > synced) throw new UnsyncedCommitsError(sessionId, at(), synced);
	const history = remoteHistory(listing, at());
	try {
		const bodies: { to: Seq; archive: boolean; read(): Promise<SyncBody | undefined> }[] = [];
		if (history.snapshot !== undefined) {
			const to = history.snapshot;
			bodies.push({ to, archive: true, read: () => remote.getSnapshot(sessionId, to, context) });
		}
		for (const batch of history.batches)
			bodies.push({
				to: batch.to,
				archive: batch.archive === true,
				read: () => remote.getBatch(sessionId, batch.after, context),
			});
		for (const body of bodies) {
			if (body.to <= at()) continue;
			const bytes = await body.read();
			if (!bytes) throw new HistoryUnavailableError(at());
			await state.set(sessionId, { syncedHead: at(), pulling: body.to }, context);
			if (body.archive) {
				if (target || local.kind !== "empty") throw new HistoryUnavailableError(at());
				target = await importStore(local.backend, decodeSnapshot(bytes), context, { outbox: true });
			} else {
				if (!target) {
					if (local.kind !== "empty") throw new Error("A store copy has no target");
					target = await openStore(local.backend, context, { outbox: true });
				}
				await applyBody(target, bytes, context);
			}
			await state.set(sessionId, { syncedHead: at() }, context);
		}
		if (!target) {
			if (local.kind !== "empty") throw new Error("A store copy has no target");
			target = await openStore(local.backend, context, { outbox: true });
		}
		const head = target.lastSeq;
		if (head < remoteHead(listing)) throw new HistoryUnavailableError(head);
		await state.set(sessionId, { syncedHead: head }, context);
		if (target.outbox && head > target.outbox.floor) await target.outbox.trim(head, context);
		return { store: target, head };
	} catch (error) {
		if (local.kind === "empty") await target?.close(context).catch(() => {});
		throw error;
	}
}
export async function foldSession(options: {
	readonly sessionId: string;
	readonly store: SessionSyncMaintenance;
	readonly scratch: Backend;
	readonly context: Context;
}): Promise<Seq | undefined> {
	const { sessionId, store, scratch, context } = options;
	const listing = await store.list(sessionId, context);
	const history = remoteHistory(listing);
	if (history.batches.length + Number(history.snapshot !== undefined) < 2) return undefined;
	let state: SyncState | undefined;
	const restored = await pullSession({
		sessionId,
		store,
		local: { kind: "empty", backend: scratch },
		context,
		state: {
			async get() {
				return state;
			},
			async set(_id, value) {
				state = value;
			},
		},
	});
	try {
		const exported = await snapshot(restored.store, context);
		try {
			await store.putSnapshot(sessionId, exported.to, exported.body, context);
		} finally {
			await exported.close();
		}
		await store.foldBatches(
			sessionId,
			history.batches.filter((batch) => batch.to <= exported.to).map((batch) => batch.after),
			context,
		);
		await store.deleteSnapshots(
			sessionId,
			listing.snapshots.filter((sequence) => sequence < exported.to),
			context,
		);
		return exported.to;
	} finally {
		await restored.store.close(context);
	}
}
export type FlushSchedulerOptions = {
	readonly flush: () => Promise<unknown>;
	readonly setTimer: (callback: () => void, delayMs: number) => () => void;
	readonly now: () => number;
	readonly onError: (error: unknown) => void;
	readonly intervalMs?: number;
	readonly urgentMs?: number;
	readonly retryMs?: number;
	readonly maxRetryMs?: number;
};
export class FlushScheduler {
	readonly #options: FlushSchedulerOptions;
	#cancel?: () => void;
	#scheduled?: number;
	#inflight?: Promise<void>;
	#next?: number;
	#failures = 0;
	#closed = false;
	constructor(options: FlushSchedulerOptions) {
		this.#options = options;
	}
	notify(urgent: boolean): void {
		if (this.#closed) return;
		const due = this.#options.now() + (urgent ? (this.#options.urgentMs ?? 200) : (this.#options.intervalMs ?? 5000));
		if (this.#inflight) this.#next = Math.min(this.#next ?? due, due);
		else this.#schedule(due);
	}
	async close(): Promise<void> {
		this.#closed = true;
		this.#cancel?.();
		this.#cancel = undefined;
		this.#scheduled = undefined;
		await this.#inflight;
		await this.#options.flush();
	}
	#schedule(due: number): void {
		if (this.#scheduled !== undefined && this.#scheduled <= due) return;
		this.#cancel?.();
		this.#scheduled = due;
		this.#cancel = this.#options.setTimer(
			() => {
				this.#cancel = undefined;
				this.#scheduled = undefined;
				this.#inflight = this.#flush();
			},
			Math.max(0, due - this.#options.now()),
		);
	}
	async #flush(): Promise<void> {
		let retry: number | undefined;
		try {
			await this.#options.flush();
			this.#failures = 0;
		} catch (error) {
			this.#options.onError(error);
			retry =
				this.#options.now() +
				Math.min((this.#options.retryMs ?? 1000) * 2 ** this.#failures++, this.#options.maxRetryMs ?? 60_000);
		} finally {
			this.#inflight = undefined;
		}
		if (this.#closed) return;
		const next = retry ?? this.#next;
		this.#next = undefined;
		if (next !== undefined) this.#schedule(next);
	}
}
