import { objectsMetrics } from "../telemetry.ts";
import type { Context } from "../context/index.ts";
import type { JsonValue } from "../json.ts";
import type { ObjectsError, Principal } from "../data/index.ts";
import type { AnyHost } from "../host/host.ts";
import {
	Channel,
	type ChannelHandler,
	type Codec,
	DeflatedPart,
	inflateAsync,
	type Limits,
	type Link,
	type Message,
	openPart,
	originPart,
	type Part,
} from "../link/internal.ts";
import { ConsumerSide } from "./consumer.ts";
import { ProviderSide } from "./provider.ts";
export type LinkRole = "parent" | "child" | "route";
type Options = {
	readonly role: LinkRole;
	readonly principal: Principal;
	readonly trusted: boolean;
	readonly codec: Codec;
	readonly limits: Limits;
};
export class HostLink implements ChannelHandler {
	readonly host: AnyHost;
	readonly role: LinkRole;
	readonly principal: Principal;
	readonly trusted: boolean;
	readonly limits: Limits;
	readonly context: Context;
	readonly consumer: ConsumerSide;
	readonly #origins = new Map<number, ProviderSide>();
	readonly #channel: Channel;
	readonly #end = new AbortController();
	readonly #calls: number | undefined;
	constructor(host: AnyHost, link: Link, options: Options, context: Context) {
		this.host = host;
		this.role = options.role;
		this.principal = options.principal;
		this.trusted = options.trusted;
		this.limits = options.limits;
		this.context = context;
		this.consumer = new ConsumerSide(this);
		this.#calls = options.trusted ? undefined : host.callWindow;
		this.#channel = new Channel(
			link,
			this,
			{
				codec: options.codec,
				trusted: options.trusted,
				incarnation: host.incarnation,
				calls: this.#calls,
				report: (error) => host.report({ kind: "protocol_error", error }),
				metrics: objectsMetrics(host.telemetry.metrics),
			},
			context,
		);
		objectsMetrics(host.telemetry.metrics).upDownCounter("objects.links.open").add(1);
		this.#channel.start();
	}
	get peer(): string {
		return this.#channel.peer;
	}
	get greeted(): boolean {
		return this.#channel.opened;
	}
	get open(): boolean {
		return !this.#channel.closed;
	}
	send(message: Message): void {
		this.#channel.send(message);
	}
	close(): void {
		this.#channel.close();
	}
	tick(now: number, paused: number, ping: number, close: number): void {
		this.#channel.tick(now, paused, ping, close);
	}
	opened(): void {
		this.consumer.opened(this.#channel.peerCalls);
		this.host.linkOpened(this);
	}
	part(json: string, context: Context): Part {
		return originPart(json, this.host.compression, context);
	}
	openPart(part: Part, limits: Limits, context: Context): string | Uint8Array {
		return openPart(part, limits, this.host.compression, context);
	}
	inflates(part: Part | undefined, limits: Limits): part is DeflatedPart {
		return (
			part instanceof DeflatedPart &&
			part.inflated === undefined &&
			!this.host.compression &&
			part.bytes.byteLength <= limits.part
		);
	}
	async inflate(parts: readonly (readonly [DeflatedPart, number])[], handle: () => void): Promise<void> {
		for (const [part, limit] of parts) {
			await inflateAsync(part, limit, this.#end.signal, this.context);
			if (this.#end.signal.aborted) return;
		}
		handle();
	}
	message(message: Message): void | Promise<void> {
		if (this.role === "child" && "origin" in message && message.origin !== undefined)
			throw new Error(`${message.kind}: an origin on a child link`);
		switch (message.kind) {
			case "hold": {
				const origin = message.origin ?? 0;
				let provider = this.#origins.get(origin);
				if (!provider) {
					provider = new ProviderSide(this, origin, this.#calls);
					this.#origins.set(origin, provider);
				}
				return provider.message(message);
			}
			case "release":
			case "call":
			case "abort":
			case "retry":
			case "ack":
				return this.#origins.get(message.origin ?? 0)?.message(message);
			case "closed":
				this.#origins.get(message.origin)?.closed();
				this.#origins.delete(message.origin);
				return;
			case "bound":
			case "state":
			case "failed":
			case "loading":
			case "result":
			case "error":
			case "gone":
			case "event":
				return this.consumer.message(message);
			case "revoke":
				if (this.role === "parent") this.host.revoke(message.revocation as JsonValue, this.context);
				return;
			default:
				return;
		}
	}
	drop(provider: ProviderSide): void {
		if (this.#origins.get(provider.origin) !== provider) return;
		this.#origins.delete(provider.origin);
		provider.closed();
	}
	revokeUnbound(revoked: (principal: Principal) => boolean, error: ObjectsError): void {
		for (const side of this.#origins.values()) side.revokeUnbound(revoked, error);
	}
	closed(): void {
		objectsMetrics(this.host.telemetry.metrics).upDownCounter("objects.links.open").add(-1);
		this.#end.abort();
		for (const side of this.#origins.values()) side.closed();
		this.#origins.clear();
		this.consumer.closed();
		this.host.unlink(this);
	}
}
