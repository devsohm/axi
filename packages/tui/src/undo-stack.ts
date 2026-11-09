export class UndoStack<S> {
	#snapshots: S[] = [];

	get length(): number {
		return this.#snapshots.length;
	}

	push(value: S): void {
		const snapshot = structuredClone(value);
		this.#snapshots.push(snapshot);
	}

	pop(): S | undefined {
		return this.#snapshots.pop();
	}

	clear(): void {
		this.#snapshots = [];
	}
}
