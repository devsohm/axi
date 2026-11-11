import type { Context } from "@axi/objects/context";
import { withoutAbortSignal } from "@axi/objects/context";
import { SessionFailed } from "../errors.ts";
import type { CommitResult, Seq, StorageWrite } from "../types.ts";

export type PublishFailure = { readonly kind: "adoption" | "listener"; readonly error: unknown };
export type PartSpec = {
	readonly index: number;
	readonly writes: readonly StorageWrite[] | undefined;
	readonly keys: readonly string[];
	readonly context: Context;
	publish(seq: Seq | undefined): PublishFailure | undefined;
	discard(): void;
};
export type Part = PartSpec & { readonly outcome: Promise<void> };
type Pending = Part & {
	readonly result: PromiseWithResolvers<void>;
	readonly gate: PromiseWithResolvers<void>;
	settled: boolean;
};
export type WriterHost = {
	commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		context: Context,
	): Promise<CommitResult>;
	stored(writes: readonly StorageWrite[]): void;
	publishing(publish: () => void, context: Context): Promise<void> | undefined;
	failure(): { readonly error: unknown } | undefined;
	fail(error: unknown, at: number, own: readonly number[]): void;
	report(error: unknown, context: Context): void;
};
type Rejection = { part: Pending; published: boolean; own: { error: unknown } | undefined };

export class Writer {
	readonly #host: WriterHost;
	readonly #keys = new Map<string, Pending>();
	#pending: Pending[] = [];
	#busy = false;
	#last: Pending | undefined;
	constructor(host: WriterHost) {
		this.#host = host;
	}
	admit(spec: PartSpec): Part {
		const result = Promise.withResolvers<void>();
		result.promise.catch(() => {});
		const part: Pending = {
			...spec,
			outcome: result.promise,
			result,
			gate: Promise.withResolvers<void>(),
			settled: false,
		};
		for (const key of part.keys) this.#keys.set(key, part);
		this.#last = part;
		this.#pending.push(part);
		this.#start();
		return part;
	}
	gate(key: string): Promise<void> | undefined {
		return this.#keys.get(key)?.gate.promise;
	}
	drained(): Promise<void> | undefined {
		return this.#last?.gate.promise;
	}
	get unpublished(): number {
		return this.#keys.size;
	}
	#start(): void {
		if (this.#busy || this.#pending.length === 0) return;
		this.#busy = true;
		const parts = this.#pending;
		this.#pending = [];
		void this.#run(parts);
	}
	async #run(parts: readonly Pending[]): Promise<void> {
		try {
			await this.#store(parts);
		} catch (error) {
			this.#host.fail(error, parts[0].index, []);
			for (const part of parts) {
				if (!part.settled) this.#discard(part, this.#failed(error));
				this.#forget(part);
				this.#open(part);
			}
		} finally {
			this.#busy = false;
			this.#start();
		}
	}
	async #store(parts: readonly Pending[]): Promise<void> {
		const before = this.#host.failure();
		if (before) {
			for (const part of parts) this.#discard(part, new SessionFailed(before.error));
			return;
		}
		const stored = parts.filter(
			(part): part is Pending & { writes: readonly StorageWrite[] } => part.writes !== undefined,
		);
		// Receipts establish durability, not visibility. Wait for storage to settle
		// before adopting each accepted batch, including a refused group's stored prefix.
		const seqs = new Map<number, Seq>();
		let result: CommitResult | undefined, rejection: { error: unknown } | undefined;
		if (stored.length) {
			try {
				result = await this.#host.commit(
					stored.map((part) => part.writes),
					(index, seq) => seqs.set(index, seq),
					withoutAbortSignal(stored[0].context),
				);
			} catch (error) {
				rejection = { error };
			}
		}
		const after = this.#host.failure();
		if (after) {
			for (const part of parts) this.#discard(part, new SessionFailed(after.error));
			return;
		}
		const rejected: Rejection[] = [];
		let stopped: { error: unknown; at: number; external: boolean } | undefined;
		let writeIndex = 0,
			published = 0;
		for (const part of parts) {
			const index = part.writes === undefined ? undefined : writeIndex++;
			if (stopped) {
				rejected.push({
					part,
					published: false,
					own: rejection && index !== undefined && !stopped.external ? rejection : undefined,
				});
				continue;
			}
			const seq = index === undefined ? undefined : seqs.get(index);
			if (index !== undefined && seq === undefined) {
				const error = rejection
					? rejection.error
					: result && index === result.stored && "refused" in result
						? result.refused
						: new Error("Storage committed without adopting the batch");
				rejected.push({ part, published: false, own: { error } });
				stopped = { error, at: part.index, external: false };
				continue;
			}
			if (published++ > 0) await yieldTurn();
			let publicationFailure: PublishFailure | undefined;
			let external: { readonly error: unknown } | undefined;
			const publishing = this.#host.publishing(() => {
				external = this.#host.failure();
				if (external) return;
				this.#forget(part);
				try {
					if (part.writes !== undefined) this.#host.stored(part.writes);
					publicationFailure = part.publish(seq);
				} catch (error) {
					publicationFailure = { kind: "adoption", error };
				}
			}, part.context);
			if (publishing) await publishing;
			if (external) {
				stopped = { error: external.error, at: part.index, external: true };
				rejected.push({ part, published: false, own: undefined });
			} else if (publicationFailure?.kind === "adoption") {
				stopped = { error: publicationFailure.error, at: part.index, external: false };
				rejected.push({ part, published: true, own: { error: publicationFailure.error } });
			} else if (rejection) {
				if (publicationFailure) this.#host.report(publicationFailure.error, part.context);
				rejected.push({ part, published: true, own: rejection });
			} else {
				if (publicationFailure) stopped = { error: publicationFailure.error, at: part.index, external: false };
				const failed = this.#host.failure();
				this.#settle(part, failed && !publicationFailure ? { error: new SessionFailed(failed.error) } : undefined);
				this.#open(part);
			}
		}
		if (rejection || stopped) {
			await Promise.resolve();
			const own = rejected.filter((item) => item.own !== undefined).map((item) => item.part.index);
			if (rejection) this.#host.fail(rejection.error, own[0], own);
			else if (stopped) this.#host.fail(stopped.error, stopped.at, own);
		}
		for (const item of rejected) {
			const error = item.own ? item.own.error : this.#failed(stopped?.error);
			if (item.published) {
				this.#settle(item.part, { error });
				this.#open(item.part);
			} else this.#discard(item.part, error);
		}
		const failure = this.#host.failure();
		if (failure) {
			const pending = this.#pending;
			this.#pending = [];
			for (const part of pending) this.#discard(part, new SessionFailed(failure.error));
		}
	}
	#settle(part: Pending, rejected: { error: unknown } | undefined): void {
		part.settled = true;
		if (rejected) part.result.reject(rejected.error);
		else part.result.resolve();
	}
	#failed(fallback: unknown): SessionFailed {
		const failure = this.#host.failure();
		return new SessionFailed(failure ? failure.error : fallback);
	}
	#discard(part: Pending, error: unknown): void {
		part.discard();
		this.#settle(part, { error });
		this.#forget(part);
		this.#open(part);
	}
	#forget(part: Pending): void {
		for (const key of part.keys) if (this.#keys.get(key) === part) this.#keys.delete(key);
	}
	#open(part: Pending): void {
		part.gate.resolve();
		if (this.#last === part) this.#last = undefined;
	}
}
function yieldTurn(): Promise<void> {
	if (typeof setImmediate === "function") return new Promise((resolve) => setImmediate(resolve));
	return new Promise((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = () => {
			channel.port1.close();
			channel.port2.close();
			resolve();
		};
		channel.port2.postMessage(undefined);
	});
}
