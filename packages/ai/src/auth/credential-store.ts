import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "./types.ts";
export class InMemoryCredentialStore implements CredentialStore {
	readonly #values = new Map<string, Credential>();
	readonly #pending = new Map<string, Promise<unknown>>();
	#enqueue<T>(id: string, operation: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
		const signal = operationSignal(options?.signal);
		const prior = this.#pending.get(id) ?? Promise.resolve();
		const task = prior
			.catch(() => {})
			.then(() => {
				signal.throwIfAborted();
				return operation();
			});
		const tail = task.catch(() => {});
		this.#pending.set(id, tail);
		void tail.then(() => {
			if (this.#pending.get(id) === tail) this.#pending.delete(id);
		});
		return raceWithAbortSignal(task, signal);
	}
	async read(id: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return this.#values.get(id);
	}
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		return [...this.#values].map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}
	modify(
		id: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#enqueue(
			id,
			async () => {
				const before = this.#values.get(id),
					next = await fn(before);
				options?.signal?.throwIfAborted();
				if (next !== undefined) this.#values.set(id, next);
				return next ?? before;
			},
			options,
		);
	}
	delete(id: string, options?: AuthOperationOptions): Promise<void> {
		return this.#enqueue(
			id,
			async () => {
				this.#values.delete(id);
			},
			options,
		);
	}
}
