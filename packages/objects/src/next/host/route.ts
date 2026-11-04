import type { Context } from "../../context/index.ts";
import type { Address, HostKind, KindShape } from "../contracts/index.ts";
import { kindParams, type ParamsData } from "../contracts/internal.ts";
import { ObjectsError, type Principal } from "../data/index.ts";
import { asObjectsError, checkAddress } from "../data/internal.ts";
import type { Codec, Link, PartLimits } from "../link/index.ts";
import type { HostLink } from "../remote/host-link.ts";
import { Path, type PathEvent, type Upstream } from "../remote/path.ts";
import type { AnyHost } from "./host.ts";
export type RouteOptions<P extends Principal, K extends KindShape> = {
	authorize(principal: P, address: Address<K>): boolean;
	resolve(
		address: Address<K>,
		context: Context,
	): Promise<{
		readonly link: Link;
		readonly principal: P;
		readonly trusted?: boolean;
		readonly codec?: Codec;
		readonly limits?: PartLimits;
	}>;
};
export type RouteHandle<K extends KindShape> = {
	retry(address: Address<K>): void;
	suspend(address: Address<K>): void;
};
type Entry = {
	readonly address: Address;
	readonly path: Path;
	resolving: boolean;
	suspended: boolean;
	failure: ObjectsError | undefined;
};
export class Route {
	readonly kind: string;
	readonly #fields: ParamsData;
	readonly #options: RouteOptions<Principal, KindShape>;
	readonly #host: AnyHost;
	readonly #context: Context;
	readonly #entries = new Map<string, Entry>();
	readonly #connections = new Map<HostLink, { entry: Entry; ready: boolean }>();
	constructor(kind: HostKind, options: RouteOptions<Principal, KindShape>, host: AnyHost, context: Context) {
		this.kind = kind.kind;
		this.#fields = kindParams(kind);
		this.#options = options;
		this.#host = host;
		this.#context = context;
	}
	path(params: unknown, principal: Principal | undefined, context: Context): Path {
		const address = checkAddress(this.kind, this.#fields, params, context);
		if (principal === undefined || !this.#options.authorize(principal, address))
			throw new ObjectsError({ code: "forbidden", message: `${address.key}: not authorized` });
		let entry = this.#entries.get(address.key);
		if (!entry) {
			const made: Entry = {
				address,
				path: new Path((event) => this.#changed(made, event)),
				resolving: false,
				suspended: false,
				failure: undefined,
			};
			this.#entries.set(address.key, made);
			entry = made;
		}
		return entry.path;
	}
	retry(key: string): void {
		const entry = this.#entries.get(key);
		if (!entry) return;
		entry.suspended = false;
		entry.failure = undefined;
		if (entry.path.held && !entry.path.link && !entry.resolving && !this.#host.closing) void this.#connect(entry);
	}
	suspend(key: string): void {
		const entry = this.#entries.get(key);
		if (!entry?.path.held) return;
		entry.suspended = true;
		if (!entry.path.link && !entry.resolving) this.#fail(entry, this.#suspended(entry));
	}
	opened(link: HostLink): void {
		const connection = this.#connections.get(link);
		if (connection) connection.ready = true;
	}
	closed(link: HostLink): boolean {
		const connection = this.#connections.get(link);
		if (!connection) return false;
		this.#connections.delete(link);
		if (!connection.ready) connection.entry.failure = this.#handshakeError(connection.entry);
		connection.entry.path.disconnected(link);
		return true;
	}
	holders(): Upstream[] {
		return Array.from(this.#entries.values(), (entry) => entry.path.holders()).flat();
	}
	#changed(entry: Entry, event: PathEvent): void {
		if (this.#host.closing) return;
		if (event.kind === "released") {
			entry.suspended = false;
			if (!entry.path.link && !entry.resolving) this.#entries.delete(entry.address.key);
		} else if (event.kind === "attached") {
			if (entry.suspended) event.holder.unreachable(this.#suspended(entry));
			else if (!entry.resolving) void this.#connect(entry);
		} else if (!entry.path.held) this.#entries.delete(entry.address.key);
		else if (entry.suspended) entry.path.unreachable(this.#suspended(entry));
		else if (entry.failure) entry.path.unreachable(entry.failure);
		else void this.#connect(entry);
	}
	async #connect(entry: Entry): Promise<void> {
		entry.resolving = true;
		let result: Awaited<ReturnType<RouteOptions<Principal, KindShape>["resolve"]>>;
		try {
			result = await this.#options.resolve(entry.address, this.#context);
		} catch (error) {
			entry.resolving = false;
			if (!this.#host.closing) {
				this.#host.report({ kind: "resolve_failed", address: entry.address.key, error });
				this.#fail(entry, asObjectsError(error, entry.address.key));
			}
			return;
		}
		entry.resolving = false;
		if (this.#host.closing) {
			result.link.close();
			return;
		}
		const { link: transport, ...options } = result;
		const link = this.#host.routeLink(transport, options, this.#context);
		if (!link.open) {
			this.#fail(entry, this.#handshakeError(entry));
			return;
		}
		entry.failure = undefined;
		this.#connections.set(link, { entry, ready: link.greeted });
		entry.path.connected(link);
	}
	#fail(entry: Entry, error: ObjectsError): void {
		if (!entry.path.held) {
			this.#entries.delete(entry.address.key);
			return;
		}
		entry.failure = error;
		entry.path.unreachable(entry.suspended ? this.#suspended(entry) : error);
	}
	#suspended(entry: Entry): ObjectsError {
		return new ObjectsError({ code: "unavailable", message: `${entry.address.key}: suspended` });
	}
	#handshakeError(entry: Entry): ObjectsError {
		return new ObjectsError({
			code: "unavailable",
			message: `${entry.address.key}: the link closed before its handshake`,
		});
	}
}
