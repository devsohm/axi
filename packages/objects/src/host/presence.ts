import type { Context } from "../context/index.ts";
import type { Op } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import { Source } from "../state/internal.ts";
import type { Caller } from "./ctx.ts";

export type Presence<C extends Contract = Contract, P extends Principal = Principal> = {
	readonly params: ParamsOf<C>;
	readonly principal?: P;
	readonly incarnation: string;
};
type Holder = { readonly caller: Caller };
type ObjectPresence = {
	readonly params: ParamsOf<Contract>;
	readonly served: { readonly kind: "local" | "remote" };
};

export class References extends Source {
	readonly #entries = new Map<Holder, Presence>();
	#snapshot: readonly Presence[] | undefined;
	#added: Presence[] = [];
	readonly #removed = new Set<Presence>();
	#changes: Op[] = [];
	get value(): JsonValue {
		if (!this.#snapshot) {
			this.#snapshot = [...this.#entries.values()];
			this.#added = [];
			this.#removed.clear();
			this.#changes = [];
		} else {
			if (this.#removed.size) {
				const retained: Presence[] = [];
				for (const entry of this.#snapshot) {
					if (this.#removed.has(entry)) this.#changes.push(["p", [], retained.length, 1, []]);
					else retained.push(entry);
				}
				this.#snapshot = retained;
				this.#removed.clear();
			}
			if (this.#added.length) {
				this.#changes.push(["p", [], this.#snapshot.length, 0, this.#added as unknown as JsonValue[]]);
				this.#snapshot = [...this.#snapshot, ...this.#added];
				this.#added = [];
			}
		}
		return this.#snapshot as unknown as JsonValue;
	}
	record(object: ObjectPresence, holder: Holder): Presence {
		const principal = holder.caller.principal,
			entry: Presence = {
				params: object.params,
				incarnation: holder.caller.incarnation,
				...(object.served.kind === "remote" && principal !== undefined ? { principal } : {}),
			};
		this.#entries.set(holder, entry);
		return entry;
	}
	add(object: ObjectPresence, holder: Holder, context: Context): void {
		this.batch.within(() => {
			const entry = this.record(object, holder);
			if (this.#tracking()) this.#added.push(entry);
			this.changed();
		}, context);
	}
	remove(holders: Iterable<Holder>, context: Context): void {
		this.batch.within(() => {
			const track = this.#tracking();
			for (const holder of holders) {
				const entry = this.#entries.get(holder);
				if (!entry) continue;
				this.#entries.delete(holder);
				if (!track) continue;
				const added = this.#added.indexOf(entry);
				if (added < 0) this.#removed.add(entry);
				else this.#added.splice(added, 1);
			}
			this.changed();
		}, context);
	}
	deliver(context: Context): void {
		const value = this.value,
			changes = this.#changes;
		this.#changes = [];
		if (changes.length) this.publish(value, changes, false, context);
	}
	#tracking(): boolean {
		if (this.watched && this.#snapshot !== undefined) return true;
		this.#snapshot = undefined;
		return false;
	}
}
