import type { Context } from "@axi/chord";
import { SessionFailed } from "../errors.ts";
import type { Cursor, Page } from "../types.ts";

export class Waiters<K, T> {
	readonly #pending = new Map<K, Set<PromiseWithResolvers<T>>>();
	add(key: K, context: Context): Promise<T> {
		const signal = context.abortSignal;
		if (signal?.aborted) return Promise.reject(signal.reason);
		const waiter = Promise.withResolvers<T>();
		const group = this.#pending.get(key) ?? new Set<PromiseWithResolvers<T>>();
		group.add(waiter);
		this.#pending.set(key, group);
		if (signal) {
			const cancel = () => {
				group.delete(waiter);
				if (!group.size && this.#pending.get(key) === group) this.#pending.delete(key);
				waiter.reject(signal.reason);
			};
			signal.addEventListener("abort", cancel, { once: true });
			const detach = () => signal.removeEventListener("abort", cancel);
			waiter.promise.then(detach, detach);
		}
		return waiter.promise;
	}
	keys(): K[] {
		return [...this.#pending.keys()];
	}
	resolve(key: K, value: T): void {
		const group = this.#pending.get(key);
		this.#pending.delete(key);
		for (const waiter of group ?? []) waiter.resolve(value);
	}
	rejectAll(error: unknown): void {
		const groups = [...this.#pending.values()];
		this.#pending.clear();
		for (const group of groups) for (const waiter of group) waiter.reject(error);
	}
}
export async function scanAll<T>(scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> {
	const all: T[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await scan(cursor);
		all.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return all;
}
export function closedError(session: { readonly failure: { readonly error: unknown } | undefined }): Error {
	return session.failure === undefined ? new Error("Harness is closed") : new SessionFailed(session.failure.error);
}
export function optionalExtension(extension: string | undefined): { readonly extension?: string } {
	return extension === undefined ? {} : { extension };
}
