import type { Context } from "../context/index.ts";
import type { SyncBody } from "./batch.ts";

export type Seq = number;
export type JsonObject = Record<string, unknown>;
export const LOG_START: Seq = 0;
export type BatchInfo = {
	readonly after: Seq;
	readonly to: Seq;
	readonly device: string;
	readonly folded?: true;
	readonly archive?: true;
};
export type RemoteListing = { readonly batches: readonly BatchInfo[]; readonly snapshots: readonly Seq[] };
export type PutBatchResult =
	| { readonly type: "created" }
	| { readonly type: "exists"; readonly to: Seq; readonly device: string }
	| { readonly type: "not_head"; readonly head: Seq }
	| { readonly type: "stale_epoch"; readonly epoch: number };
export type SessionSummary = { readonly id: string; readonly head: Seq; readonly meta: JsonObject | undefined };
export type SessionChanges = {
	readonly sessions: readonly SessionSummary[];
	readonly cursor: string;
	readonly more: boolean;
};
export interface SessionSyncStore {
	putBatch(
		sessionId: string,
		after: Seq,
		to: Seq,
		device: string,
		body: SyncBody,
		context: Context,
		options?: { readonly archive?: boolean; readonly epoch?: number },
	): Promise<PutBatchResult>;
	getBatch(sessionId: string, after: Seq, context: Context): Promise<SyncBody | undefined>;
	getSnapshot(sessionId: string, to: Seq, context: Context): Promise<SyncBody | undefined>;
	list(sessionId: string, context: Context): Promise<RemoteListing>;
	sessions(cursor: string | undefined, context: Context): Promise<SessionChanges>;
	putMeta(sessionId: string, meta: JsonObject, context: Context): Promise<void>;
	getMeta(sessionId: string, context: Context): Promise<JsonObject | undefined>;
}
export interface SessionSyncMaintenance extends SessionSyncStore {
	putSnapshot(sessionId: string, to: Seq, body: SyncBody, context: Context): Promise<void>;
	foldBatches(sessionId: string, afters: readonly Seq[], context: Context): Promise<void>;
	deleteSnapshots(sessionId: string, snapshots: readonly Seq[], context: Context): Promise<void>;
}
export type RemoteHistory = { readonly snapshot?: Seq; readonly batches: readonly BatchInfo[]; readonly head: Seq };
export class HistoryUnavailableError extends Error {
	constructor(head: Seq) {
		super(`The remote history does not continue from ${head}`);
		this.name = "HistoryUnavailableError";
	}
}
export function remoteHistory(listing: RemoteListing, from?: Seq): RemoteHistory {
	const restore = from === undefined || from === LOG_START;
	const snapshot = restore && listing.snapshots.length ? listing.snapshots.reduce((a, b) => Math.max(a, b)) : undefined;
	let head = snapshot ?? from ?? LOG_START;
	const batches: BatchInfo[] = [];
	if (!restore) {
		const containing = listing.batches.find((batch) => batch.after < head && head < batch.to);
		if (containing) {
			batches.push(containing);
			head = containing.to;
		}
	}
	const slots = new Map(listing.batches.map((batch) => [batch.after, batch]));
	while (slots.has(head)) {
		const next = slots.get(head)!;
		batches.push(next);
		head = next.to;
	}
	return { ...(snapshot === undefined ? {} : { snapshot }), batches, head };
}
export function remoteHead(listing: RemoteListing): Seq {
	const slots = new Map(listing.batches.map((batch) => [batch.after, batch.to]));
	let head = LOG_START;
	while (slots.has(head)) head = slots.get(head)!;
	return head;
}
