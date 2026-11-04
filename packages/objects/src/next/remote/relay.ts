import { ObjectsError } from "../data/index.ts";
import type { Caller } from "../host/ctx.ts";
import { type Message, wireError } from "../link/internal.ts";
import { actingFor, type HoldRequest } from "./hold.ts";
import type { HostLink } from "./host-link.ts";
import type { Path } from "./path.ts";
import type { ProviderSide } from "./provider.ts";
export class RelayedHold {
	readonly kind = "relayed";
	readonly id: number;
	readonly caller: Caller;
	readonly #provider: ProviderSide;
	readonly #request: HoldRequest;
	readonly #path: Path;
	#connection: { readonly link: HostLink; readonly origin: number } | undefined;
	constructor(id: number, downstream: ProviderSide, request: HoldRequest, caller: Caller, path: Path) {
		this.id = id;
		this.caller = caller;
		this.#provider = downstream;
		this.#path = path;
		this.#request = {
			...request,
			params: typeof request.params === "string" ? request.params : (request.params as Uint8Array).slice(),
		};
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
		link.send({ kind: "hold", origin, hold: this.id, ...this.#request, ...actingFor(link, this.caller) });
	}
	dropped(error: ObjectsError): void {
		const was = this.#connection;
		this.#connection = undefined;
		if (was) this.#provider.upstreamDropped(this, error);
	}
	unreachable(error: ObjectsError): void {
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
	call(message: Extract<Message, { kind: "call" }>): void {
		if (this.#connection) this.#connection.link.send({ ...message, origin: this.#connection.origin });
		else
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
		this.#connection = undefined;
		this.#path.detach(this);
	}
}
