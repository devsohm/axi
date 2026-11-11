import type { Context } from "../context/index.ts";
import type { EventMember, EventSubscription } from "../contracts/index.ts";
import type { JsonValue } from "../json.ts";
import {
	EventNode,
	type EventEntry,
	type EventFlush,
	type EventListener,
	type Subscription,
	type Tap,
} from "./events.ts";
import type { Attachable, Binding } from "./reference.ts";

export class ReferenceEvents implements EventMember<JsonValue> {
	readonly binding: Binding;
	readonly member: string;
	constructor(binding: Binding, member: string) {
		this.binding = binding;
		this.member = member;
	}
	on(listener: EventListener, context: Context): Promise<EventSubscription> {
		return this.binding.subscribeEvents(this.member, listener, context);
	}
}
export class ReexposedEvents extends EventNode {
	readonly #source: ReferenceEvents;
	constructor(source: ReferenceEvents) {
		super();
		this.#source = source;
	}
	attach(): void {
		this.#source.binding.forwardEvents(this.#source.member, this);
	}
	detach(): void {
		this.#source.binding.unforwardEvents(this.#source.member, this);
		this.clear();
	}
}
type Position = { readonly instance: Attachable; readonly boundAt: number };
type Readers = {
	readonly subscriptions: Set<Subscription>;
	readonly forwards: Set<EventNode>;
	attachment: { node: EventNode; tap: Tap } | undefined;
};
export class ReferenceEventTaps {
	readonly #version: number;
	readonly #members = new Map<string, Readers>();
	#position: Position | undefined;
	constructor(version: number, at: Position | undefined) {
		this.#version = version;
		this.#position = at;
	}
	retarget(at: Position | undefined): void {
		this.#position = at;
		for (const [member, readers] of this.#members) this.#attach(member, readers);
	}
	subscribe(member: string, subscription: Subscription): void {
		this.#readers(member).subscriptions.add(subscription);
	}
	forward(member: string, node: EventNode): void {
		this.#readers(member).forwards.add(node);
	}
	unsubscribe(member: string, subscription: Subscription): void {
		const readers = this.#members.get(member);
		if (readers) {
			readers.subscriptions.delete(subscription);
			this.#prune(member, readers);
		}
	}
	unforward(member: string, node: EventNode): void {
		const readers = this.#members.get(member);
		if (readers) {
			readers.forwards.delete(node);
			this.#prune(member, readers);
		}
	}
	end(): void {
		const records = [...this.#members.values()];
		this.#members.clear();
		for (const readers of records) {
			this.#untap(readers);
			for (const subscription of readers.subscriptions) subscription.stop();
		}
	}
	#readers(member: string): Readers {
		let readers = this.#members.get(member);
		if (!readers) {
			readers = { subscriptions: new Set(), forwards: new Set(), attachment: undefined };
			this.#members.set(member, readers);
			this.#attach(member, readers);
		}
		return readers;
	}
	#untap(readers: Readers): void {
		const attachment = readers.attachment;
		if (attachment) attachment.node.untap(attachment.tap);
		readers.attachment = undefined;
	}
	#attach(member: string, readers: Readers): void {
		this.#untap(readers);
		const position = this.#position;
		const node = position?.instance.eventNode(member, this.#version);
		if (!position || !node) return;
		const tap: Tap = {
			boundAt: position.boundAt,
			deliver: (entry: EventEntry, flush: EventFlush) => {
				for (const subscription of readers.subscriptions) flush.call(subscription, entry);
				for (const forward of readers.forwards) forward.deliver(entry, flush);
			},
		};
		readers.attachment = { node, tap };
		node.tap(tap);
	}
	#prune(member: string, readers: Readers): void {
		if (readers.subscriptions.size || readers.forwards.size) return;
		this.#members.delete(member);
		this.#untap(readers);
	}
}
