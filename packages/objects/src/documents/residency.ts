import type { Tracker } from "../delta/index.ts";
import type { JsonObject } from "./definition.ts";
import type { Stored } from "./persistence.ts";

export class Resident {
	readonly slot: { evict(resident: Resident): void };
	readonly key: string;
	tracker: Tracker<JsonObject>;
	stored: Stored | undefined;
	version: number;
	constructor(
		slot: { evict(resident: Resident): void },
		key: string,
		tracker: Tracker<JsonObject>,
		stored: Stored | undefined,
		version: number,
	) {
		this.slot = slot;
		this.key = key;
		this.tracker = tracker;
		this.stored = stored;
		this.version = version;
	}
}
export const RETENTION_MS = 10 * 60_000;
const GRANULE_MS = Math.min(1_000, RETENTION_MS / 10);
type Sweep = { timer: ReturnType<typeof setTimeout> | undefined };
export class Residency {
	readonly #onLine: (sweep: () => void) => void;
	readonly #idle = new Map<Resident, number>();
	#scheduled: Sweep | undefined;
	#ended = false;
	constructor(onLine: (sweep: () => void) => void) {
		this.#onLine = onLine;
	}
	touch(resident: Resident): void {
		const now = Date.now(),
			previous = this.#idle.get(resident);
		if (previous !== undefined && now - previous < GRANULE_MS) return;
		this.#idle.delete(resident);
		this.#idle.set(resident, now);
		if (!this.#scheduled) this.#schedule();
	}
	forget(resident: Resident): void {
		this.#idle.delete(resident);
	}
	end(): void {
		this.#ended = true;
		this.#idle.clear();
		clearTimeout(this.#scheduled?.timer);
		this.#scheduled = undefined;
	}
	#schedule(): void {
		const first = this.#idle.values().next();
		if (this.#ended || first.done) return;
		const sweep: Sweep = { timer: undefined };
		this.#scheduled = sweep;
		sweep.timer = setTimeout(
			() =>
				this.#onLine(() => {
					if (this.#scheduled === sweep) this.#scheduled = undefined;
					if (this.#ended) return;
					const cutoff = Date.now() - RETENTION_MS;
					for (const [resident, touched] of this.#idle) {
						if (touched > cutoff) break;
						this.#idle.delete(resident);
						resident.slot.evict(resident);
					}
					if (!this.#scheduled) this.#schedule();
				}),
			Math.max(0, first.value + RETENTION_MS - Date.now()),
		);
	}
}
