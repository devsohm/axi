import type { Contract } from "../contracts/index.ts";
import { ObjectsError } from "../data/index.ts";
import type { ObjectsObject } from "./object.ts";
import type { OldWorkSource } from "./old-work.ts";

type Waiting = {
	readonly target: ObjectsObject;
	readonly contract: Contract;
	readonly chain: ReadonlySet<OldWorkSource>;
	readonly reject: (error: ObjectsError) => void;
};
export class ReloadCycles {
	readonly #pending = new Set<Waiting>();
	wait<T>(work: Promise<T>, target: ObjectsObject, contract: Contract, chain: ReadonlySet<OldWorkSource>): Promise<T> {
		const result = Promise.withResolvers<T>();
		const pending: Waiting = { target, contract, chain, reject: result.reject };
		this.#pending.add(pending);
		void work.then(
			(value) => {
				this.#pending.delete(pending);
				result.resolve(value);
			},
			(error) => {
				this.#pending.delete(pending);
				result.reject(error);
			},
		);
		this.#check(pending);
		return result.promise;
	}
	recheck(): void {
		for (const pending of this.#pending) this.#check(pending);
	}
	#check(pending: Waiting): void {
		if (pending.target.oldServes(pending.contract.version, pending.contract.fingerprint)) return;
		const visited = new Set([pending.target]);
		const search = (object: ObjectsObject): string[] | undefined => {
			for (const next of object.waitEdges()) {
				if (visited.has(next)) continue;
				visited.add(next);
				const old = next.openOldAttempt;
				if (old && pending.chain.has(old)) return [next.label];
				const path = search(next);
				if (path) return [next.label, ...path];
			}
		};
		const path = search(pending.target);
		if (!path) return;
		this.#pending.delete(pending);
		const route = [pending.target.label, ...path].join(" → ");
		pending.reject(
			new ObjectsError({
				code: "unavailable",
				reason: "reload_cycle",
				message: `${pending.target.label}: work its reload drains waits for it, and it waits for that drain (${route})`,
			}),
		);
	}
}
