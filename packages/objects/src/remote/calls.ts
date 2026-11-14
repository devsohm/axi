export type QueuedCall<H = number> = { readonly hold: H; readonly send: () => void };

export class CallWindow<C extends QueuedCall<unknown> = QueuedCall> {
	#capacity = 0;
	#active = 0;
	readonly #queued = new Set<C>();
	submit(call: C): void {
		if (this.#queued.size || this.#active >= this.#capacity) this.#queued.add(call);
		else {
			this.#active++;
			call.send();
		}
	}
	opened(limit: number | undefined): void {
		this.#capacity = limit ?? Infinity;
		this.#dispatch();
	}
	freed(): void {
		this.#active--;
		this.#dispatch();
	}
	remove(call: C): void {
		this.#queued.delete(call);
	}
	removeHold(hold: C["hold"]): C[] {
		return this.removeWhere((call) => call.hold === hold);
	}
	removeWhere(matches: (call: C) => boolean): C[] {
		const removed: C[] = [];
		for (const call of this.#queued)
			if (matches(call)) {
				this.#queued.delete(call);
				removed.push(call);
			}
		return removed;
	}
	clear(): C[] {
		const calls = [...this.#queued];
		this.#queued.clear();
		return calls;
	}
	#dispatch(): void {
		for (const call of this.#queued) {
			if (this.#active >= this.#capacity) break;
			this.#queued.delete(call);
			this.#active++;
			call.send();
		}
	}
}
