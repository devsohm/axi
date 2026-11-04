import type { Context } from "../../context/index.ts";
import type { Op } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Watch, WatchCall, WatchEnd } from "../../watch.ts";
import { ObjectsError } from "../data/index.ts";
import { Source, type Batch, type Subscriber } from "../state/internal.ts";

export type FollowObserver<T> = {
	advance(call: WatchCall<T>, context: Context): void;
	end(end: WatchEnd): void;
};
export type FollowAttachment<T> = { readonly value: T; detach(): void };
export type FollowAttach<T> = (
	observer: FollowObserver<unknown>,
	context: Context,
) => Promise<FollowAttachment<T> | undefined>;
export type FollowOwner = {
	readonly label: string;
	readonly context: Context;
	ended(end: WatchEnd): void;
};
type Status =
	| { readonly kind: "attaching"; readonly end: WatchEnd | undefined }
	| { readonly kind: "attached" | "ended"; readonly detach: () => void }
	| { readonly kind: "detached" };
const ended: WatchEnd = { kind: "ended" };

export class FollowSource extends Source {
	readonly #attach: FollowAttach<JsonValue>;
	readonly #owner: FollowOwner;
	#status: Status = { kind: "attaching", end: undefined };
	#value: JsonValue | undefined;
	#pending: WatchCall<JsonValue>[] = [];
	#scheduled = false;
	#finish: "none" | "queued" | "frame" = "none";
	#ops: Op[] = [];
	#retired = false;
	#listed = false;
	constructor(attach: FollowAttach<JsonValue>, owner: FollowOwner, batch: Batch) {
		super(batch);
		this.#attach = attach;
		this.#owner = owner;
	}
	get value(): JsonValue {
		if (this.#value === undefined)
			throw new ObjectsError({
				code: "not_ready",
				message: `${this.#owner.label}: a followed source read before it attached`,
			});
		return this.#value;
	}
	async attach(context: Context): Promise<void> {
		const observer: FollowObserver<JsonValue> = {
			advance: (call) => this.#advance(call),
			end: (end) => this.#ended(end),
		};
		const attachment = await this.#attach(observer, context);
		if (!attachment)
			throw new ObjectsError({
				code: "unavailable",
				message: `${this.#owner.label}: the followed address is absent`,
			});
		const state = this.#status,
			detach = (): void => attachment.detach();
		if (state.kind !== "attaching") {
			detach();
			return;
		}
		this.#value = attachment.value;
		for (const call of this.#pending) if (call.kind === "value") this.#value = call.value;
		this.#pending = [];
		this.#status = {
			kind: state.end?.kind === "ended" ? "ended" : "attached",
			detach,
		};
	}
	detach(): void {
		const state = this.#status;
		this.#status = { kind: "detached" };
		this.#pending = [];
		if (state.kind === "attached" || state.kind === "ended") state.detach();
		this.endWatches();
	}
	openWatch(context: Context): Watch<JsonValue> {
		const watch = super.openWatch(context);
		if (this.#over) watch.end(ended);
		return watch;
	}
	subscribe(subscriber: Subscriber): void {
		if (this.#over) subscriber.end(ended);
		else super.subscribe(subscriber);
	}
	deliver(context: Context): void {
		const ops = this.#ops,
			retired = this.#retired;
		this.#ops = [];
		this.#retired = false;
		this.#listed = false;
		this.publish(this.#value!, ops, retired, context);
		if (this.#finish === "frame") {
			this.#finish = "none";
			this.endWatchesAfterDelivery();
		}
	}
	get #over(): boolean {
		return this.#status.kind === "detached" || (this.#status.kind === "ended" && this.#finish === "none");
	}
	#advance(call: WatchCall<JsonValue>): void {
		const state = this.#status;
		if (state.kind === "detached" || state.kind === "ended") return;
		if (state.kind === "attaching" || !this.batch.running) {
			this.#pending.push(call);
			if (state.kind === "attached") this.#schedule();
			return;
		}
		this.#applyPending();
		this.#apply(call);
	}
	#ended(end: WatchEnd): void {
		const state = this.#status;
		if (state.kind === "detached" || state.kind === "ended") return;
		if (state.kind === "attaching") {
			if (!state.end) this.#status = { kind: "attaching", end };
		} else if (end.kind === "ended") {
			this.#status = { kind: "ended", detach: state.detach };
			if (this.#pending.length && !this.batch.running) this.#finish = "queued";
			else {
				this.#applyPending();
				this.#endAfterFrame();
			}
		}
		this.#owner.ended(end);
	}
	#endAfterFrame(): void {
		this.#finish = this.#listed ? "frame" : "none";
		if (!this.#listed) this.endWatchesAfterDelivery();
	}
	#schedule(): void {
		if (this.#scheduled) return;
		this.#scheduled = true;
		this.batch.soon(() => {
			this.#scheduled = false;
			if (this.#status.kind === "attached" || this.#status.kind === "ended") this.#applyPending();
			if (this.#finish === "queued") this.#endAfterFrame();
		}, this.#owner.context);
	}
	#applyPending(): void {
		const pending = this.#pending;
		if (!pending.length) return;
		this.#pending = [];
		for (const call of pending) this.#apply(call);
	}
	#apply(call: WatchCall<JsonValue>): void {
		if (call.kind !== "value") return;
		this.#value = call.value;
		this.#retired ||= call.retired;
		if (this.watched) {
			for (const op of call.ops) this.#ops.push(op);
			if (!this.#listed) {
				this.#listed = true;
				this.changed();
			}
		} else this.changed();
		if (call.retired) this.retiredInBatch();
	}
}
