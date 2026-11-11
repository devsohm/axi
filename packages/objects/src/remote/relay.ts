import { ObjectsError } from "../data/index.ts";
import type { TelemetryCarrier, TelemetrySpan } from "@axi/telemetry";
import { OpenSpan, carrierOf, ended, parentOf, spanFailed, untraced } from "../telemetry.ts";
import type { Caller } from "../host/ctx.ts";
import { errorFromWire, type Message, type OriginMessage, wireError } from "../link/internal.ts";
import type { CallWindow } from "./calls.ts";
import { actingFor, type HoldRequest } from "./hold.ts";
import type { HostLink } from "./host-link.ts";
import type { Path } from "./path.ts";
import type { ProviderSide } from "./provider.ts";
type CallMessage = Extract<Message, { kind: "call" }>;
type Reply = Extract<OriginMessage, { kind: "result" | "error" }>;
type CallState =
	| { kind: "new" | "ended" }
	| { kind: "queued"; window: CallWindow<RelayedCall> }
	| { kind: "forwarded"; window: CallWindow<RelayedCall>; span: OpenSpan | undefined };
export class RelayedCall {
	readonly kind = "relayed";
	readonly hold: RelayedHold;
	readonly message: CallMessage;
	#state: CallState = { kind: "new" };
	constructor(hold: RelayedHold, message: CallMessage) {
		this.hold = hold;
		this.message = message;
	}
	get forwarded(): boolean {
		return this.#state.kind === "forwarded";
	}
	queue(window: CallWindow<RelayedCall>): void {
		this.#state = { kind: "queued", window };
		window.submit(this);
	}
	send(): void {
		const { window } = this.#state as Extract<CallState, { kind: "queued" }>;
		this.#state = { kind: "forwarded", window, span: this.hold.call(this.message) };
	}
	unqueue(): boolean {
		const state = this.#state;
		if (state.kind !== "queued") return false;
		this.#state = { kind: "ended" };
		state.window.remove(this);
		return true;
	}
	end(reply?: Reply): void {
		const state = this.#state;
		this.#state = { kind: "ended" };
		if (state.kind === "queued") state.window.remove(this);
		if (state.kind !== "forwarded") return;
		if (state.span) {
			state.span.span.setAttributes({
				outcome: !reply
					? "aborted"
					: reply.kind === "result"
						? "ok"
						: ended(state.span.span, "relay_failed", errorFromWire(reply.error)),
			});
			state.span.end();
		}
		state.window.freed();
	}
}
export function endAll(calls: readonly RelayedCall[]): void {
	for (const call of calls) call.unqueue();
	for (const call of calls) call.end();
}
export class RelayedHold {
	readonly kind = "relayed";
	readonly id: number;
	readonly caller: Caller;
	readonly #provider: ProviderSide;
	readonly #request: HoldRequest;
	readonly #path: Path;
	#connection: { readonly link: HostLink; readonly origin: number } | undefined;
	#relaying?: OpenSpan;
	#trace?: TelemetryCarrier;
	#holds = 0;
	constructor(id: number, downstream: ProviderSide, request: HoldRequest, caller: Caller, path: Path) {
		this.id = id;
		this.caller = caller;
		this.#provider = downstream;
		this.#path = path;
		const { trace, ...fields } = request;
		this.#request = {
			...fields,
			params: typeof request.params === "string" ? request.params : (request.params as Uint8Array).slice(),
		};
		this.#trace = trace;
		const adapter = downstream.link.host.telemetry;
		if (!untraced(adapter)) {
			this.#relaying = new OpenSpan(parentOf(request.trace, adapter), "objects.relay", this.#attributes("hold"));
			this.#trace = carrierOf(this.#relaying.span) ?? this.#trace;
		}
	}
	get span(): TelemetrySpan | undefined { return this.#relaying?.span; }
	#attributes(member: string) {
		return { "objects.host": this.#provider.link.host.spanHost, type: this.#request.type.slice(0, 256), member, "upstream.kind": this.#request.address.kind.slice(0, 256) };
	}
	#relayed(error?: ObjectsError): void {
		if (!this.#relaying) return;
		if (error) spanFailed(this.#relaying.span, "relay_failed", error);
		this.#relaying.span.setAttributes({ outcome: error ? "error" : "ok" });
		this.#relaying.end();
		this.#relaying = undefined;
	}
	start(): void {
		this.#provider.relayed(this);
		this.#path.attach(this);
	}
	heldOn(link: HostLink): boolean {
		return this.#connection?.link === link;
	}
	attach(link: HostLink): void {
		const origin = this.#provider.relayTo(link);
		this.#connection = { link, origin };
		const first = this.#holds++ === 0;
		let trace = first ? this.#trace : undefined;
		if (!first && this.#trace !== undefined && !untraced(link.host.telemetry)) {
			const again = new OpenSpan(link.host.telemetry, "objects.relay", this.#attributes("hold"));
			again.span.addLink({ context: parentOf(this.#trace, link.host.telemetry) });
			trace = carrierOf(again.span);
			again.span.setAttributes({ outcome: "ok" });
			again.end();
		}
		link.send({ kind: "hold", origin, hold: this.id, ...this.#request, ...(trace === undefined ? {} : { trace }), ...actingFor(link, this.caller) });
		this.#relayed();
	}
	dropped(error: ObjectsError): void {
		const was = this.#connection;
		this.#connection = undefined;
		if (was) this.#provider.upstreamDropped(this, error);
	}
	unreachable(error: ObjectsError): void {
		this.#relayed(error);
		this.#provider.send({ kind: "failed", hold: this.id, cause: { kind: "waiting", error: wireError(error) } });
	}
	get waiting(): boolean {
		return !this.#connection;
	}
	revoked(error: ObjectsError): void {
		this.lost();
		this.#provider.send({ kind: "gone", hold: this.id, error: wireError(error) });
	}
	lost(): void {
		this.drop();
		this.#provider.forget(this);
	}
	submit(call: RelayedCall): void {
		const connection = this.#connection;
		if (connection) call.queue(connection.link.consumer.relayWindow(connection.origin));
		else
			this.#provider.reply(call.message.call, {
				kind: "error",
				call: call.message.call,
				error: wireError(
					new ObjectsError({ code: "unavailable", message: `hold ${this.id}: its upstream link is down` }),
				),
			});
	}
	call(message: CallMessage): OpenSpan | undefined {
		if (this.#connection) {
			const { link, origin } = this.#connection;
			const { old, ...unmarked } = message;
			const forwarded = old && !this.#provider.link.trusted ? unmarked : message;
			const span = untraced(link.host.telemetry) ? undefined : new OpenSpan(parentOf(message.trace, link.host.telemetry), "objects.relay", this.#attributes(`#${message.method}`));
			const trace = span ? carrierOf(span.span) ?? message.trace : message.trace;
			link.send({ ...forwarded, origin, ...(trace === undefined ? {} : { trace }) });
			return span;
		} else
			this.#provider.reply(message.call, {
				kind: "error",
				call: message.call,
				error: wireError(
					new ObjectsError({ code: "unavailable", message: `hold ${this.id}: its upstream link is down` }),
				),
			});
	}
	abort(id: number): void {
		this.#connection?.link.send({ kind: "abort", origin: this.#connection.origin, call: id });
	}
	retry(message: Extract<Message, { kind: "retry" }>): void {
		this.#connection?.link.send({ ...message, origin: this.#connection.origin });
	}
	release(): void {
		const connection = this.#connection;
		this.drop();
		connection?.link.send({ kind: "release", origin: connection.origin, hold: this.id });
	}
	drop(): void {
		if (this.#relaying) { this.#relaying.span.setAttributes({ outcome: "aborted" }); this.#relaying.end(); this.#relaying = undefined; }
		this.#connection = undefined;
		this.#path.detach(this);
	}
}
