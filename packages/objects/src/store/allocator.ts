export const FIRST_ID = 2;

export class IdAllocator {
	#next: number;
	constructor(next: number) {
		this.#next = next;
	}
	get value(): number {
		return this.#next;
	}
	mint(): number {
		if (this.#next >= Number.MAX_SAFE_INTEGER) throw new Error("ID space is exhausted");
		return this.#next++;
	}
	raise(id: number): void {
		if (id >= this.#next) this.#next = Math.min(Number.MAX_SAFE_INTEGER, id + 1);
	}
}
