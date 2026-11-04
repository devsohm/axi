import type { Context } from "../context/index.ts";
import type { Address, Contract, ParamsOf } from "../contracts/index.ts";
import { contractData } from "../contracts/internal.ts";
import { ObjectsError, type Principal } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import type { WireAddress } from "../link/internal.ts";
import type { HoldRequest } from "../remote/hold.ts";
import type { HostLink } from "../remote/host-link.ts";
import type { Path } from "../remote/path.ts";
import type { Route } from "./route.ts";
export type Placed =
	| { readonly kind: "here" }
	| { readonly kind: "path"; readonly path: Path; readonly address: WireAddress };
const local: Placed = { kind: "here" };
export class Destination {
	readonly #own: Address | undefined;
	readonly #routes: ReadonlyMap<string, Route>;
	readonly #parent: Path;
	constructor(address: Address | undefined, routes: ReadonlyMap<string, Route>, parent: Path) {
		this.#own = address;
		this.#routes = routes;
		this.#parent = parent;
	}
	reference(type: Contract, params: ParamsOf<Contract>, principal: Principal | undefined, context: Context): Placed {
		if (type.kind === "local") return local;
		const address = this.#compute(type, params);
		return this.#matches(address)
			? local
			: { kind: "path", path: this.#route(address, principal, context) ?? this.#parent, address };
	}
	placedHere(type: Contract, params: ParamsOf<Contract>): boolean {
		return type.kind === "local" || this.#matches(this.#compute(type, params));
	}
	hold(request: HoldRequest, link: HostLink, principal: Principal | undefined, context: Context): Placed {
		if (this.#matches(request.address)) return local;
		const path = this.#route(request.address, principal, context);
		if (path) return { kind: "path", path, address: request.address };
		if (link.role !== "parent" && this.#parent.linked)
			return { kind: "path", path: this.#parent, address: request.address };
		throw new ObjectsError({ code: "unavailable", message: `${request.type} is not served here` });
	}
	misplaced(type: Contract, params: ParamsOf<Contract>): ObjectsError | undefined {
		const address = this.#compute(type, params);
		return this.#matches(address)
			? undefined
			: invalid("host_address", `${type.name}: placed on ${address.kind}, this host is ${this.#own!.key}`);
	}
	#compute(type: Contract, params: ParamsOf<Contract>): WireAddress {
		const address = contractData(type).hostAddress!(params) as { readonly kind: string; readonly params: unknown };
		return { kind: address.kind, params: address.params };
	}
	#route(address: WireAddress, principal: Principal | undefined, context: Context): Path | undefined {
		return this.#routes.get(address.kind)?.path(address.params, principal, context);
	}
	#matches(address: WireAddress): boolean {
		const own = this.#own;
		if (!own || own.kind !== address.kind || address.params === null || typeof address.params !== "object")
			return false;
		const values = address.params as Record<string, unknown>,
			keys = Object.keys(own.params);
		return Object.keys(values).length === keys.length && keys.every((key) => own.params[key] === values[key]);
	}
}
