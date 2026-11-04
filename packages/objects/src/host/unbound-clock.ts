import type { ObjectsError } from "../data/index.ts";

export type UnboundLong = { readonly kind: "unbound_long"; readonly waitingFor: string; readonly error: ObjectsError; readonly since: number };
type Wait = { readonly waitingFor: string; error: ObjectsError; readonly since: number };
export class UnboundClock {
	readonly #waiting = new Map<object, Wait>();
	readonly #report: (event: UnboundLong) => void;
	#timer: ReturnType<typeof setTimeout> | undefined;
	constructor(report: (event: UnboundLong) => void) { this.#report = report; }
	start(key: object, waitingFor: string, error: ObjectsError): void {
		if (this.#waiting.has(key)) return;
		this.#waiting.set(key, { waitingFor, error, since: Date.now() });
		this.#timer ??= setTimeout(() => this.#sweep(), 5000);
	}
	failed(key: object, error: ObjectsError): void {
		const wait = this.#waiting.get(key);
		if (wait) wait.error = error;
	}
	stop(key: object): void {
		this.#waiting.delete(key);
		if (!this.#waiting.size) { clearTimeout(this.#timer); this.#timer = undefined; }
	}
	close(): void {
		this.#waiting.clear();
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}
	#sweep(): void {
		this.#timer = undefined;
		for (const [key, wait] of this.#waiting) {
			const remaining = wait.since + 5000 - Date.now();
			if (remaining > 0) { this.#timer = setTimeout(() => this.#sweep(), remaining); break; }
			this.#waiting.delete(key);
			this.#report({ kind: "unbound_long", ...wait });
		}
	}
}
