import type { Context } from "../context/index.ts";
import type { TelemetryCarrier } from "@axi/telemetry";
import { carrierOf } from "../telemetry.ts";
import { type MethodData, takesNoArgs } from "../contracts/internal.ts";
import { ObjectsError, isObjectsError } from "../data/index.ts";
import { asObjectsError } from "../data/internal.ts";
import type { RetryOperation } from "../host/reference.ts";
import {
	type BoundEntry,
	type ConsumerMessage,
	type DeflatedPart,
	errorFromWire,
	type Message,
	parsePayload,
	payloadPart,
	type StateEntry,
	type WireEvent,
} from "../link/internal.ts";
import { CallWindow, type QueuedCall } from "./calls.ts";
import { actingFor } from "./hold.ts";
import type { HostLink } from "./host-link.ts";
import type { RemoteObject } from "./remote-object.ts";
type Reply = Extract<Message, { kind: "result" | "error" }>;
type Request = {
	readonly hold: number;
	readonly send: () => void;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
	id?: number;
};
export class ConsumerSide {
	readonly #link: HostLink;
	readonly #holders = new Map<number, RemoteObject>();
	readonly #requests = new Map<number, Request>();
	readonly #window = new CallWindow<Request>();
	readonly #relayed = new Map<number, CallWindow<QueuedCall<unknown>>>();
	#greeted: { readonly calls: number | undefined } | undefined;
	#consumed = 0;
	#holdId = 0;
	#callId = 0;
	constructor(link: HostLink) {
		this.#link = link;
	}
	attach(holder: RemoteObject, chain: string[] | undefined, trace?: TelemetryCarrier): number {
		const hold = this.#holdId++;
		this.#holders.set(hold, holder);
		this.#link.send({
			kind: "hold",
			hold,
			...holder.request,
			...(trace === undefined ? {} : { trace }),
			...actingFor(this.#link, holder.caller),
			...(chain === undefined ? {} : { chain }),
		});
		return hold;
	}
	call(hold: number, method: number, data: MethodData, args: unknown, context: Context): Promise<unknown> {
		const signal = context.abortSignal;
		signal?.throwIfAborted();
		const payload = takesNoArgs(data) ? undefined : payloadPart(args, data.args.bytes);
		const trace = carrierOf(context.telemetry);
		const part = !payload
			? undefined
			: this.#link.role === "parent"
				? payload.json
				: this.#link.part(payload.json, context);
		// A reload while waiting for a send slot must not change this call's ancestry.
		const old = this.#link.host.oldWork.of(context);
		const result = Promise.withResolvers<unknown>();
		const cancel = (): void => {
			this.#cancel(request);
			request.reject(signal!.reason);
		};
		const settle = (): void => signal?.removeEventListener("abort", cancel);
		const request: Request = {
			hold,
			resolve: (value) => {
				settle();
				result.resolve(value);
			},
			reject: (error) => {
				settle();
				result.reject(error);
			},
			send: () => {
				const call = this.#callId++;
				request.id = call;
				this.#requests.set(call, request);
				this.#link.send({
					kind: "call",
					call,
					hold,
					method,
					...(old ? { old: true } : {}),
					...(trace === undefined ? {} : { trace }),
					...(part === undefined ? {} : { args: part }),
					...(payload?.segments === undefined ? {} : { segments: payload.segments }),
				});
			},
		};
		signal?.addEventListener("abort", cancel, { once: true });
		this.#window.submit(request);
		return result.promise;
	}
	release(hold: number, error: ObjectsError): void {
		this.#link.send({ kind: "release", hold });
		this.forget(hold, error);
	}
	retry(hold: number, operation: RetryOperation): void {
		this.#link.send({
			kind: "retry",
			hold,
			hops: operation.hops,
		});
	}
	forget(hold: number, error: ObjectsError): void {
		this.#holders.delete(hold);
		const requests = this.#window.removeHold(hold);
		for (const [id, request] of this.#requests)
			if (request.hold === hold) {
				this.#requests.delete(id);
				this.#window.freed();
				requests.push(request);
			}
		for (const request of requests) request.reject(error);
	}
	opened(calls: number | undefined): void {
		this.#greeted = { calls };
		this.#window.opened(calls);
		for (const window of this.#relayed.values()) window.opened(calls);
	}
	relayWindow<C extends QueuedCall<unknown>>(origin: number): CallWindow<C> {
		let window = this.#relayed.get(origin);
		if (!window) {
			window = new CallWindow();
			if (this.#greeted) window.opened(this.#greeted.calls);
			this.#relayed.set(origin, window);
		}
		return window as CallWindow<C>;
	}
	unrelay(origin: number): void {
		this.#relayed.delete(origin);
	}
	message(message: ConsumerMessage): void | Promise<void> {
		if (message.origin !== undefined) {
			this.#link.host.relays.get(message.origin)?.forward(message, this.#link);
			return;
		}
		switch (message.kind) {
			case "bound":
			case "state": {
				const parts = this.#compressed(message.holds);
				if (parts) return this.#link.inflate(parts, () => this.message(message));
				this.#apply(message.holds, message.kind === "bound");
				return;
			}
			case "event": {
				const parts: [DeflatedPart, number][] = [];
				for (const entry of message.events)
					if (
						this.#link.inflates(entry.value, this.#link.limits) &&
						this.#holders.get(entry.hold)?.eventNode(entry.member)
					)
						parts.push([entry.value, this.#link.limits.decoded]);
				if (parts.length) return this.#link.inflate(parts, () => this.message(message));
				this.#events(message.events);
				return;
			}
			case "failed": {
				const holder = this.#holders.get(message.hold);
				if (!holder) return;
				const error = asObjectsError(errorFromWire(message.cause.error), `hold ${message.hold}`);
				for (const request of this.#window.removeHold(message.hold)) request.reject(error);
				holder.failed(message);
				return;
			}
			case "loading": {
				const holder = this.#holders.get(message.hold);
				if (!holder) return;
				const error = new ObjectsError({ code: "unavailable", message: `hold ${message.hold}: rebinding` });
				for (const request of this.#window.removeHold(message.hold)) request.reject(error);
				holder.loading();
				return;
			}
			case "result":
			case "error":
				return this.#reply(message);
			case "gone":
				this.#holders.get(message.hold)?.lost(asObjectsError(errorFromWire(message.error), `hold ${message.hold}`));
				return;
		}
	}
	closed(): void {
		const pending = [...this.#requests.values(), ...this.#window.clear()];
		this.#requests.clear();
		this.#holders.clear();
		this.#relayed.clear();
		const error = new ObjectsError({ code: "unavailable", message: "the link closed" });
		for (const request of pending) request.reject(error);
	}
	#cancel(request: Request): void {
		if (request.id === undefined) {
			this.#window.remove(request);
			return;
		}
		if (this.#requests.delete(request.id)) {
			this.#link.send({ kind: "abort", call: request.id });
			this.#window.freed();
		}
	}
	#compressed(entries: readonly (BoundEntry | StateEntry)[]): [DeflatedPart, number][] | undefined {
		let parts: [DeflatedPart, number][] | undefined;
		for (const entry of entries)
			if (this.#holders.has(entry.hold))
				for (const member of entry.members) {
					const part = "value" in member ? member.value : member.ops;
					if (this.#link.inflates(part, this.#link.limits)) {
						parts ??= [];
						parts.push([part, this.#link.limits.decoded]);
					}
				}
		return parts;
	}
	#events(entries: readonly WireEvent[]): void {
		for (const entry of entries) this.#holders.get(entry.hold)?.event(entry.member, entry.at, entry.value, this.#link);
		if (this.#consumed++ !== 0) return;
		queueMicrotask(() => {
			const count = this.#consumed;
			this.#consumed = 0;
			this.#link.send({ kind: "ack", events: count });
		});
	}
	#apply(entries: readonly (BoundEntry | StateEntry)[], bound: boolean): void {
		const actions: (() => void)[] = [],
			live: RemoteObject[] = [];
		let large: [RemoteObject, ObjectsError][] | undefined;
		for (const entry of entries) {
			const holder = this.#holders.get(entry.hold);
			if (!holder) continue;
			try {
				if ("variant" in entry) {
					actions.push(holder.prepareBound(entry, this.#link));
					live.push(holder);
				} else actions.push(holder.prepare(entry, this.#link));
			} catch (error) {
				if (!isObjectsError(error, "too_large")) throw error;
				large ??= [];
				large.push([holder, error]);
			}
		}
		if (actions.length)
			this.#link.host.batch.commit(() => {
				for (const action of actions) action();
			}, this.#link.context);
		// Rebinding calls must follow the acknowledgement that changes their method indexes.
		if (bound) this.#link.send({ kind: "ack" });
		for (const holder of live) holder.wentLive();
		for (const [holder, error] of large ?? []) holder.tooLarge(error);
		if (!bound) this.#link.send({ kind: "ack" });
	}
	#reply(reply: Reply): void | Promise<void> {
		const request = this.#requests.get(reply.call);
		if (!request) return;
		const link = this.#link;
		if (reply.kind === "result" && link.inflates(reply.value, link.limits))
			return link.inflate([[reply.value, link.limits.decoded]], () => this.#reply(reply));
		this.#requests.delete(reply.call);
		this.#window.freed();
		try {
			if (reply.kind === "error") request.reject(errorFromWire(reply.error));
			else
				request.resolve(
					reply.value === undefined
						? null
						: parsePayload(link.openPart(reply.value, link.limits, link.context), reply.segments),
				);
		} catch (error) {
			if (isObjectsError(error, "too_large")) {
				request.reject(error);
				return;
			}
			request.reject(new ObjectsError({ code: "unavailable", message: `call ${reply.call}: a malformed reply` }));
			throw error;
		}
	}
}
