import { invalid } from "../data/internal.ts";

export type Claimant = { readonly label: string };
export class Claims {
	readonly #holders = new Map<string, Claimant>();
	readonly #owned = new Map<Claimant, Set<string>>();
	#locked = false;
	get held(): boolean {
		return this.#owned.size > 0;
	}
	table(table: string, claimant: Claimant): void {
		this.#claim(`table ${JSON.stringify(table)}`, claimant);
	}
	documents(owner: string, namespace: string, claimant: Claimant): void {
		this.#claim(`documents ${JSON.stringify([owner, namespace])}`, claimant);
	}
	assertTable(table: string, claimant: Claimant): void {
		this.#assert(`table ${JSON.stringify(table)}`, claimant);
	}
	assertDocuments(owner: string, namespace: string, claimant: Claimant): void {
		this.#assert(`documents ${JSON.stringify([owner, namespace])}`, claimant);
	}
	lock(): () => void {
		this.#locked = true;
		return () => {
			this.#locked = false;
		};
	}
	release(claimant: Claimant): void {
		for (const key of this.#owned.get(claimant) ?? []) this.#holders.delete(key);
		this.#owned.delete(claimant);
	}
	#claim(key: string, claimant: Claimant): void {
		this.#assert(key, claimant);
		if (this.#holders.get(key) === claimant) return;
		this.#holders.set(key, claimant);
		let owned = this.#owned.get(claimant);
		if (!owned) {
			owned = new Set();
			this.#owned.set(claimant, owned);
		}
		owned.add(key);
	}
	#assert(key: string, claimant: Claimant): void {
		if (this.#locked) throw invalid("args", `store: ${key} cannot be claimed while a batch applies`);
		const holder = this.#holders.get(key);
		if (holder && holder !== claimant) throw invalid("args", `store: ${key} is claimed by ${holder.label}`);
	}
}
