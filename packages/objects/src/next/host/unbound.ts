import type { ObjectsError, Principal } from "../data/index.ts";

export interface UnboundRequest {
	readonly principal: Principal | undefined;
	wake(): void;
	end(error: ObjectsError): void;
}
export class UnboundIndex {
	readonly #names = new Map<string, Set<UnboundRequest>>();
	add(name: string, request: UnboundRequest): void {
		let entries = this.#names.get(name);
		if (!entries) {
			entries = new Set();
			this.#names.set(name, entries);
		}
		entries.add(request);
	}
	delete(name: string, request: UnboundRequest): boolean {
		const entries = this.#names.get(name);
		if (!entries?.delete(request)) return false;
		if (!entries.size) this.#names.delete(name);
		return true;
	}
	wake(names: Iterable<string>): void {
		const pending: UnboundRequest[] = [];
		for (const name of names) {
			const entries = this.#names.get(name);
			if (entries) {
				this.#names.delete(name);
				pending.push(...entries);
			}
		}
		for (const request of pending) request.wake();
	}
	wakeAll(): void {
		const requests = this.#takeAll();
		for (const request of requests) request.wake();
	}
	revoke(revoked: (principal: Principal) => boolean, error: ObjectsError): void {
		for (const entries of [...this.#names.values()])
			for (const request of [...entries])
				if (request.principal !== undefined && revoked(request.principal)) request.end(error);
	}
	close(error: ObjectsError): void {
		const requests = this.#takeAll();
		for (const request of requests) request.end(error);
	}
	#takeAll(): UnboundRequest[] {
		const requests = [...this.#names.values()].flatMap((entries) => [...entries]);
		this.#names.clear();
		return requests;
	}
}
