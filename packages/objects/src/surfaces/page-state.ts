import type { Principal } from "../data/index.ts";
import type { Host } from "../host/index.ts";

// Function properties prevent a narrow writable state from widening.
export type PageState<T> = {
	readonly read: () => T;
	readonly set: (value: T) => void;
	readonly subscribe: (listener: () => void) => () => void;
};
const states = new WeakMap<object, Map<string, PageState<unknown>>>();

export function pageState<T, P extends Principal = Principal>(host: Host<P>, key: string, initial: T): PageState<T> {
	let entries = states.get(host);
	if (!entries) states.set(host, (entries = new Map()));
	const existing = entries.get(key);
	if (existing) return existing as PageState<T>;
	let value = initial;
	const listeners = new Set<() => void>();
	const state: PageState<T> = {
		read: () => value,
		set(next) {
			if (value === next) return;
			value = next;
			for (const listener of listeners) listener();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	entries.set(key, state as PageState<unknown>);
	return state;
}
