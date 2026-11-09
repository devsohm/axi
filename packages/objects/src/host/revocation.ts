import type { Context } from "../context/index.ts";
import type { JsonValue } from "../json.ts";
import type { Principal } from "../data/index.ts";
import { canonicalJson } from "../data/internal.ts";

export type RevokedBy<P extends Principal, R extends JsonValue> = (principal: P) => readonly R[];
export class RevocationKeys {
	readonly #identify: RevokedBy<Principal, JsonValue> | undefined;
	readonly #cache = new WeakMap<Principal, ReadonlySet<string>>();
	constructor(revokedBy: RevokedBy<Principal, JsonValue> | undefined) {
		this.#identify = revokedBy;
	}
	revokes(principal: Principal, key: string, context: Context): boolean {
		const identify = this.#identify;
		if (!identify) return false;
		let keys = this.#cache.get(principal);
		if (!keys) {
			keys = new Set(identify(principal).map((value) => canonicalJson(value, context)));
			this.#cache.set(principal, keys);
		}
		return keys.has(key);
	}
}
