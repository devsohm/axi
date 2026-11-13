import { ObjectsError } from "../data/index.ts";
import type { HostLink } from "./host-link.ts";
import type { RelayedHold } from "./relay.ts";
import type { RemoteObject } from "./remote-object.ts";

export type Upstream = RemoteObject | RelayedHold;
export type PathEvent =
	| { readonly kind: "attached"; readonly holder: Upstream }
	| { readonly kind: "released" }
	| { readonly kind: "dropped" };
export class Path {
	readonly #held = new Set<Upstream>();
	readonly #notify: (event: PathEvent) => void;
	readonly #isSuspended: () => boolean;
	#current: HostLink | undefined;
	#used = false;
	constructor(changed: (event: PathEvent) => void, isSuspended: () => boolean = () => false) {
		this.#notify = changed;
		this.#isSuspended = isSuspended;
	}
	get suspended(): boolean {
		return this.#isSuspended();
	}
	get link(): HostLink | undefined {
		return this.#current;
	}
	get linked(): boolean {
		return this.#used;
	}
	get held(): boolean {
		return this.#held.size !== 0;
	}
	attach(holder: Upstream): void {
		this.#held.add(holder);
		if (this.#current) holder.attach(this.#current);
		else this.#notify({ kind: "attached", holder });
	}
	requested(holder: Upstream): void {
		if (this.#current === undefined) this.#notify({ kind: "attached", holder });
	}
	detach(holder: Upstream): void {
		this.#held.delete(holder);
		if (!this.held) this.#notify({ kind: "released" });
	}
	connected(link: HostLink): void {
		this.#current = link;
		this.#used = true;
		for (const holder of this.#held) holder.attach(link);
	}
	disconnected(link: HostLink): void {
		if (link !== this.#current) return;
		this.#current = undefined;
		const error = new ObjectsError({ code: "unavailable", message: "the link closed" });
		for (const holder of this.#held) holder.dropped(error);
		this.#notify({ kind: "dropped" });
	}
	unreachable(error: ObjectsError): void {
		for (const holder of this.#held) holder.unreachable(error);
	}
	holders(): Upstream[] {
		return Array.from(this.#held);
	}
}
