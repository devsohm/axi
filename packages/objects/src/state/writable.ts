import type { Context } from "../context/index.ts";
import type { NativeWatchable } from "../watch.ts";
import type { Batch } from "./batch.ts";
import { FollowedSource } from "./native-source.ts";

export interface Writable<T> extends NativeWatchable<T> {
	set(value: T): void;
}
export type WritableOwner = { readonly context: Context; assertUsable(): void };
export class WritableSource<T> extends FollowedSource<T> implements Writable<T> {
	#value: T;
	#owner: WritableOwner | Error;
	constructor(initial: T, owner: WritableOwner, batch: Batch) {
		super(batch);
		this.#value = initial;
		this.#owner = owner;
	}
	get value(): T {
		return this.#value;
	}
	set(value: T): void {
		const owner = this.#owner;
		if (owner instanceof Error) throw owner;
		owner.assertUsable();
		if (value === this.#value) return;
		const batch = this.batch;
		if (!batch) return;
		batch.assertNotComputing("writable.set");
		batch.within(() => {
			this.#value = value;
			this.changed();
		}, owner.context);
	}
	detach(error: Error): void {
		void error.stack;
		this.#owner = error;
		this.end();
	}
}
