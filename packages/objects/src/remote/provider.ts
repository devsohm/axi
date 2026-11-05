import { type Context, withAbortSignal } from "../context/index.ts";
import type { TelemetryContext } from "@axi/telemetry";
import { objectsMetrics, parentOf, ended, type OpenSpan } from "../telemetry.ts";
import { ObjectsError, isObjectsError, type Principal } from "../data/index.ts";
import type { Caller } from "../host/ctx.ts";
import {
	type BoundEntry,
	type ConsumerMessage,
	DeflatedPart,
	type Message,
	type OriginMessage,
	oversized,
	type ProviderMessage,
	parsePayload,
	errorFromWire,
	payloadPart,
	type StateEntry,
	wireError,
} from "../link/internal.ts";
import { Hold } from "./hold.ts";
import type { HostLink } from "./host-link.ts";
import type { RelayedHold } from "./relay.ts";
type Running =
	| { readonly kind: "served"; readonly hold: Hold; readonly bytes: boolean; readonly abort: AbortController }
	| { readonly kind: "relayed"; readonly hold: RelayedHold; span?: OpenSpan };
type Reply = Extract<OriginMessage, { kind: "result" | "error" }>;
export class ProviderSide {
	readonly link: HostLink;
	readonly origin: number;
	readonly #limit: number;
	readonly #active = new Map<number, Running>();
	readonly #holds = new Map<number, Hold | RelayedHold>();
	readonly #acks: ("local" | HostLink)[] = [];
	readonly #pending = new Set<Hold>();
	readonly #bindings = new Set<Hold>();
	#touched: Hold[] = [];
	#ownSent = 0;
	#ownAcked = 0;
	#preferBinding = false;
	#waitingSince?: number;
	#relay: { readonly origin: number; readonly links: Set<HostLink> } | undefined;
	constructor(link: HostLink, origin: number, limit: number) {
		this.link = link;
		this.origin = origin;
		this.#limit = limit;
	}
	get nextOwn(): number {
		return this.#ownSent + 1;
	}
	acknowledged(sequence: number): boolean {
		return this.#ownAcked >= sequence;
	}
	message(message: ProviderMessage): void | Promise<void> {
		switch (message.kind) {
			case "hold":
				this.#hold(message);
				return;
			case "call":
				return this.#call(message);
			case "release": {
				const hold = this.#holds.get(message.hold);
				if (hold) {
					this.forget(hold);
					hold.release();
				}
				this.#releaseIfIdle();
				return;
			}
			case "abort":
				this.#abort(message.call);
				this.#releaseIfIdle();
				return;
			case "retry":
				this.#holds.get(message.hold)?.retry(message);
				return;
			case "ack":
				this.#ack();
				this.#releaseIfIdle();
				return;
		}
	}
	closed(): void {
		const holds = [...this.#holds.values()];
		this.#holds.clear();
		const error = new ObjectsError({ code: "unavailable", message: "the link closed" });
		for (const running of this.#active.values()) {
			if (running.kind === "served") running.abort.abort(error);
			else this.#relayEnd(running);
		}
		this.#active.clear();
		for (const hold of holds)
			if (hold.kind === "served" && !this.link.host.closing) hold.release();
			else hold.drop();
		this.#touched = [];
		if (this.#relay) {
			this.link.host.relays.delete(this.#relay.origin);
			for (const link of this.#relay.links) link.send({ kind: "closed", origin: this.#relay.origin });
		}
	}
	send(message: OriginMessage): void {
		this.link.send(this.origin ? { ...message, origin: this.origin } : message);
	}
	revokeUnbound(revoked: (principal: Principal) => boolean, error: ObjectsError): void {
		for (const hold of [...this.#holds.values()])
			if (revoked(hold.caller.principal!)) {
				if (hold.kind === "served" && hold.unbound) hold.end(error);
				else if (hold.kind === "relayed" && hold.waiting) hold.revoked(error);
			}
	}
	relayed(hold: RelayedHold): void {
		this.#holds.set(hold.id, hold);
	}
	relayTo(link: HostLink): number {
		this.#relay ??= { origin: this.link.host.relayOrigin(this), links: new Set() };
		this.#relay.links.add(link);
		return this.#relay.origin;
	}
	forward(message: ConsumerMessage, from: HostLink): void {
		const relay = this.#relay;
		if (!relay?.links.has(from)) return;
		const { origin: _origin, ...forwarded } = message;
		switch (forwarded.kind) {
			case "bound":
			case "state": {
				const holds = this.#onlyRelayed<BoundEntry | StateEntry>(forwarded.holds, from);
				if (!holds.length) {
					from.send({ kind: "ack", origin: relay.origin });
					return;
				}
				this.#acks.push(from);
				if (holds === forwarded.holds) this.send(forwarded);
				else if (forwarded.kind === "bound") this.send({ ...forwarded, holds: holds as BoundEntry[] });
				else this.send({ ...forwarded, holds: holds as readonly StateEntry[] });
				return;
			}
			case "result":
			case "error": {
				const running = this.#active.get(forwarded.call);
				if (running?.kind === "relayed" && running.hold.heldOn(from)) this.reply(forwarded.call, forwarded);
				return;
			}
			case "gone": {
				const hold = this.#relayedOn(forwarded.hold, from);
				if (hold) {
					hold.lost();
					this.send(forwarded);
				}
				return;
			}
			default:
				if (this.#relayedOn(forwarded.hold, from)) this.send(forwarded);
		}
	}
	unlinked(link: HostLink): void {
		this.#relay?.links.delete(link);
	}
	upstreamDropped(hold: RelayedHold, error: ObjectsError): void {
		for (const [id, running] of this.#active)
			if (running.hold === hold) this.reply(id, { kind: "error", call: id, error: wireError(error) });
		this.send({ kind: "loading", hold: hold.id });
	}
	forget(hold: Hold | RelayedHold, error?: ObjectsError): void {
		if (this.#holds.get(hold.id) === hold) this.#holds.delete(hold.id);
		const reason = error ?? new ObjectsError({ code: "released", message: `hold ${hold.id}: released` });
		for (const [id, running] of this.#active)
			if (running.hold === hold) {
				this.#active.delete(id);
				if (running.kind === "served") running.abort.abort(reason);
				else this.#relayEnd(running);
			}
		if (hold.kind === "served") this.unbind(hold);
		this.#releaseIfIdle();
	}
	reply(id: number, reply: Reply): void {
		const running = this.#active.get(id);
		if (!this.#active.delete(id)) return;
		if (this.#pending.size) this.#sendPending();
		this.send(reply);
		if (running?.kind === "relayed") this.#relayEnd(running, reply);
		this.#releaseIfIdle();
	}
	#releaseIfIdle(): void {
		if (!this.#holds.size && !this.#active.size && !this.#acks.length) this.link.drop(this);
	}
	bind(hold: Hold, context: Context): void {
		if (this.#free) this.#sendState({ kind: "bound", holds: [hold.boundEntry(context)] });
		else this.#bindings.add(hold);
	}
	unbind(hold: Hold): void {
		this.#pending.delete(hold);
		this.#bindings.delete(hold);
		if (!this.#pending.size && !this.#bindings.size) this.#waited();
	}
	unbound(hold: Hold, error: ObjectsError): void {
		this.unbind(hold);
		for (const [id, running] of this.#active)
			if (running.hold === hold) {
				if (running.kind === "served") running.abort.abort(error);
				this.reply(id, { kind: "error", call: id, error: wireError(error) });
			}
	}
	touched(hold: Hold): void {
		if (!this.#touched.length) this.link.host.batch.flushing((context) => this.#flush(context));
		this.#touched.push(hold);
	}
	#relayedOn(id: number, from: HostLink): RelayedHold | undefined {
		const hold = this.#holds.get(id);
		return hold?.kind === "relayed" && hold.heldOn(from) ? hold : undefined;
	}
	#onlyRelayed<E extends { readonly hold: number }>(entries: readonly E[], from: HostLink): readonly E[] {
		let selected: E[] | undefined;
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index]!;
			if (this.#relayedOn(entry.hold, from)) selected?.push(entry);
			else selected ??= entries.slice(0, index);
		}
		return selected ?? entries;
	}
	#hold(message: Extract<Message, { kind: "hold" }>): void {
		if (this.#holds.has(message.hold)) throw new Error(`hold ${message.hold}: the id is in use`);
		if (message.params instanceof DeflatedPart) throw new Error(`hold ${message.hold}: compressed params`);
		const {
			kind: _kind,
			origin: _origin,
			hold: id,
			principal: _principal,
			incarnation: _incarnation,
			chain,
			limit: stamped,
			...fields
		} = message;
		const link = this.link,
			decoded = Math.min(link.limits.decoded, link.role === "parent" ? (stamped ?? Infinity) : Infinity);
		const request = {
			...fields,
			...(chain !== undefined && link.trusted ? { chain } : {}),
			...(decoded === Infinity ? {} : { limit: decoded }),
		};
		const caller: Caller =
			link.role === "parent"
				? {
						principal: (message.principal as Principal | undefined) ?? link.principal,
						incarnation: message.incarnation ?? link.peer,
					}
				: { principal: link.principal, incarnation: link.peer };
		const hold = new Hold(
			id,
			this,
			caller,
			decoded === link.limits.decoded ? link.limits : { part: link.limits.part, decoded },
		);
		this.#holds.set(id, hold);
		hold.start(request);
	}
	#call(message: Extract<Message, { kind: "call" }>): void | Promise<void> {
		if (this.#active.has(message.call)) throw new Error(`call ${message.call}: the id is in use`);
		const hold = this.#holds.get(message.hold);
		if (!hold) return;
		if (this.#active.size >= this.#limit) throw new Error(`call ${message.call}: more than ${this.#limit} calls`);
		const part = message.args;
		if (part instanceof DeflatedPart && this.link.role === "child")
			throw new Error(`call ${message.call}: compressed arguments from a child`);
		if (hold.kind === "relayed") {
			const error = part === undefined ? undefined : oversized(part, this.link.limits.part);
			if (error) {
				this.#refuse(message.call, error);
				return;
			}
			const running: Extract<Running, { kind: "relayed" }> = { kind: "relayed", hold };
			this.#active.set(message.call, running);
			running.span = hold.call(message);
			return;
		}
		if (!hold.callable) {
			this.#refuse(message.call, hold.refusal);
			return;
		}
		const method = hold.method(message.method);
		if (this.link.inflates(part, hold.limits))
			return this.link.inflate([[part, hold.limits.decoded]], () => this.#call(message));
		let json: string | Uint8Array | undefined;
		try {
			json = part === undefined ? undefined : this.link.openPart(part, hold.limits, this.link.context);
		} catch (error) {
			if (!isObjectsError(error, "too_large")) throw error;
			this.#refuse(message.call, error);
			return;
		}
		const args = json === undefined ? null : parsePayload(json, message.segments);
		const running = { kind: "served", hold, bytes: method.resultBytes, abort: new AbortController() } as const;
		this.#active.set(message.call, running);
		void this.#run(message.call, running, method.name, args, parentOf(message.trace, this.link.host.telemetry));
	}
	async #run(
		id: number,
		running: Extract<Running, { kind: "served" }>,
		method: string,
		args: unknown,
		parent: TelemetryContext,
	): Promise<void> {
		let reply: Reply;
		try {
			const result = await running.hold.call(
				method,
				args,
				withAbortSignal(running.abort.signal, this.link.context),
				parent,
			);
			if (result == null) reply = { kind: "result", call: id };
			else {
				const payload = payloadPart(result, running.bytes);
				reply = {
					kind: "result",
					call: id,
					value: this.link.part(payload.json, this.link.context),
					...(payload.segments === undefined ? {} : { segments: payload.segments }),
				};
			}
		} catch (error) {
			reply = { kind: "error", call: id, error: wireError(error) };
		}
		this.reply(id, reply);
	}
	#refuse(id: number, error: ObjectsError): void {
		this.send({ kind: "error", call: id, error: wireError(error) });
	}
	#abort(id: number): void {
		const running = this.#active.get(id);
		if (!running) return;
		this.#active.delete(id);
		if (running.kind === "relayed") {
			this.#relayEnd(running);
			running.hold.abort(id);
		} else running.abort.abort(new ObjectsError({ code: "aborted", message: `call ${id}: aborted by its caller` }));
	}
	#ack(): void {
		const sender = this.#acks.shift();
		if (sender === undefined) return;
		if (sender !== "local") {
			sender.send({ kind: "ack", origin: this.#relay!.origin });
			return;
		}
		this.#ownAcked++;
		this.#drain();
	}
	#flush(context: Context): void {
		const holds = this.#touched;
		if (!holds.length) return;
		this.#touched = [];
		if (this.#free) {
			const entries: StateEntry[] = [];
			for (const hold of holds) if (hold.bound) entries.push(hold.entry(context));
			if (entries.length) this.#sendState({ kind: "state", holds: entries });
		} else {
			for (const hold of holds) {
				if (!hold.bound) continue;
				hold.queue();
				this.#pending.add(hold);
			}
			if (this.#pending.size) this.#waitingSince ??= performance.now();
		}
	}
	get #free(): boolean {
		return this.#ownSent - this.#ownAcked < 2 && !this.#pending.size && !this.#bindings.size;
	}
	#drain(): void {
		if (this.#ownSent - this.#ownAcked < 2 && (this.#pending.size || this.#bindings.size)) this.#waited();
		while (this.#ownSent - this.#ownAcked < 2 && (this.#pending.size || this.#bindings.size)) {
			const binding = this.#bindings.size > 0 && (!this.#pending.size || this.#preferBinding);
			if (binding) {
				const holds = [...this.#bindings];
				this.#bindings.clear();
				this.#preferBinding = false;
				this.#sendState({ kind: "bound", holds: holds.map((hold) => hold.boundEntry(this.link.context)) });
			} else {
				this.#sendPending();
			}
		}
	}
	#sendPending(): void {
		const holds = [...this.#pending];
		this.#pending.clear();
		this.#waited();
		this.#preferBinding = this.#bindings.size > 0;
		this.#sendState({ kind: "state", holds: holds.map(hold => hold.pendingEntry(this.link.context)) });
	}
	#sendState(message: Extract<OriginMessage, { kind: "bound" | "state" }>): void {
		this.#ownSent++;
		this.#acks.push("local");
		if (message.kind === "state")
			objectsMetrics(this.link.host.telemetry.metrics).counter("objects.link.state_messages").add(1);
		this.send(message);
	}
	#waited(): void {
		if (this.#waitingSince === undefined) return;
		objectsMetrics(this.link.host.telemetry.metrics)
			.histogram("objects.backpressure.wait")
			.record(performance.now() - this.#waitingSince);
		this.#waitingSince = undefined;
	}
	#relayEnd(running: Extract<Running, { kind: "relayed" }>, reply?: Reply): void {
		const span = running.span;
		if (!span) return;
		span.span.setAttributes({
			outcome: !reply
				? "aborted"
				: reply.kind === "result"
					? "ok"
					: ended(span.span, "relay_failed", errorFromWire(reply.error)),
		});
		span.end();
		running.span = undefined;
	}
}
