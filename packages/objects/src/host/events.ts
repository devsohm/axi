import type { Context } from "../context/index.ts";
import type { EventSource, EventSubscription } from "../contracts/index.ts";
import type { ObjectsError } from "../data/index.ts";
import type { JsonValue } from "../json.ts";
import type { Part } from "../link/internal.ts";
import type { ObjectsMetrics } from "../telemetry.ts";

export type EventListener = (event: { readonly value: JsonValue; readonly at: number }) => void;
export type EventReport = (info: { readonly kind: "listener_error"; readonly error: unknown }) => void;
export type EventEntry = {
	readonly node: EventNode;
	readonly value: JsonValue;
	readonly at: number;
	readonly n: number;
	part: Part | undefined;
};
export type Tap = { readonly boundAt: number; readonly deliver: (entry: EventEntry, flush: EventFlush) => void };
export interface EventSender {
	sendEvents(): void;
}
export type EventFlush = {
	readonly sending: (sender: EventSender) => void;
	readonly call: (subscription: Subscription, entry: EventEntry) => void;
};
export type SourceOwner = { readonly events: HostEvents; readonly sealed: () => ObjectsError | undefined };

export class HostEvents {
	readonly metrics: ObjectsMetrics;
	readonly #report: EventReport;
	#emitted = 0;
	#subscribed = 0;
	#pending: EventEntry[] = [];
	constructor(metrics: ObjectsMetrics, report: EventReport) {
		this.metrics = metrics;
		this.#report = report;
	}
	get counter(): number {
		return this.#emitted;
	}
	nextSubscription(): number {
		return ++this.#subscribed;
	}
	push(node: EventNode, value: JsonValue, at: number): void {
		if (!this.#pending.length) queueMicrotask(() => this.#flush());
		this.#pending.push({ node, value, at, n: ++this.#emitted, part: undefined });
	}
	#flush(): void {
		const entries = this.#pending;
		this.#pending = [];
		const senders = new Set<EventSender>();
		const listeners: { subscription: Subscription; entry: EventEntry }[] = [];
		const flush: EventFlush = {
			sending: (sender) => {
				senders.add(sender);
			},
			call: (subscription, entry) => {
				listeners.push({ subscription, entry });
			},
		};
		for (const entry of entries) entry.node.deliver(entry, flush);
		for (const sender of senders) sender.sendEvents();
		listeners.sort((a, b) => a.entry.n - b.entry.n || a.subscription.order - b.subscription.order);
		for (const { subscription, entry } of listeners) subscription.call(entry, this.#report);
	}
}

export class EventNode {
	readonly #taps = new Set<Tap>();
	get tapped(): boolean {
		return this.#taps.size > 0;
	}
	tap(tap: Tap): void {
		this.#taps.add(tap);
	}
	untap(tap: Tap): void {
		this.#taps.delete(tap);
	}
	deliver(entry: EventEntry, flush: EventFlush): void {
		// A new binding must not receive an event queued before it became live.
		for (const tap of this.#taps) if (entry.n > tap.boundAt) tap.deliver(entry, flush);
	}
	clear(): void {
		this.#taps.clear();
	}
}

export class Subscription implements EventSubscription {
	readonly order: number;
	#listener: EventListener | undefined;
	#signal: AbortSignal | undefined;
	#remove: ((subscription: Subscription) => void) | undefined;
	readonly #abort = () => this.stop();
	constructor(order: number, listener: EventListener, context: Context, remove: (subscription: Subscription) => void) {
		this.order = order;
		this.#listener = listener;
		this.#signal = context.abortSignal;
		this.#remove = remove;
		this.#signal?.addEventListener("abort", this.#abort, { once: true });
	}
	stop(): void {
		const remove = this.#remove;
		if (!remove) return;
		this.#listener = undefined;
		this.#remove = undefined;
		this.#signal?.removeEventListener("abort", this.#abort);
		this.#signal = undefined;
		remove(this);
	}
	call(entry: EventEntry, report: EventReport): void {
		const listener = this.#listener;
		if (!listener) return;
		try {
			listener({ value: entry.value, at: entry.at });
		} catch (error) {
			report({ kind: "listener_error", error });
			this.stop();
		}
	}
}
export function subscribe(
	events: HostEvents,
	listener: EventListener,
	context: Context,
	install: (subscription: Subscription) => void,
	remove: (subscription: Subscription) => void,
): Promise<EventSubscription> {
	if (context.abortSignal?.aborted) return Promise.reject(context.abortSignal.reason);
	const subscription = new Subscription(events.nextSubscription(), listener, context, remove);
	install(subscription);
	return Promise.resolve(subscription);
}

export class OwnEventSource extends EventNode implements EventSource<JsonValue> {
	readonly #owner: SourceOwner;
	#subscribers: Map<Subscription, Tap> | undefined;
	constructor(owner: SourceOwner) {
		super();
		this.#owner = owner;
	}
	ownedBy(owner: SourceOwner): boolean {
		return this.#owner === owner;
	}
	emit(value: JsonValue): void {
		const error = this.#owner.sealed();
		if (error) throw error;
		this.#owner.events.metrics.counter("objects.events.emitted").add(1);
		this.#owner.events.push(this, value, Date.now());
	}
	on(listener: EventListener, context: Context): Promise<EventSubscription> {
		const events = this.#owner.events;
		return subscribe(
			events,
			listener,
			context,
			(subscription) => {
				const tap: Tap = { boundAt: events.counter, deliver: (entry, flush) => flush.call(subscription, entry) };
				(this.#subscribers ??= new Map()).set(subscription, tap);
				this.tap(tap);
			},
			(subscription) => {
				const tap = this.#subscribers?.get(subscription);
				if (tap) {
					this.#subscribers!.delete(subscription);
					this.untap(tap);
				}
			},
		);
	}
	detach(): void {
		this.clear();
		for (const subscription of this.#subscribers?.keys() ?? []) subscription.stop();
	}
}
