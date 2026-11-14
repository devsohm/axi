import type { Context } from "../context/index.ts";
import type { Op, Prepared } from "../delta/index.ts";
import { Source } from "../state/internal.ts";
import type { JsonObject } from "./definition.ts";
import type { Documents } from "./documents.ts";

export abstract class AddressSource extends Source {
	abstract readonly owner: Documents;
	abstract override get value(): JsonObject;
	#ops: readonly Op[] = [];
	#retired = false;
	deliver(context: Context): void {
		this.publish(this.value, this.#ops, this.#retired, context);
		this.#ops = [];
		this.#retired = false;
	}
	written(before: JsonObject, prepared: Prepared<JsonObject>): void {
		if (this.watched) this.#ops = !this.#retired && before === prepared.base ? prepared.ops : [["r", prepared.value]];
		this.changed();
	}
	retired(initial: JsonObject): void {
		if (this.watched) {
			this.#retired = true;
			this.#ops = [["r", initial]];
		}
		this.changed();
		this.retiredInBatch();
	}
	replaced(): void {
		if (this.watched) this.#ops = [["r", this.value]];
		this.changed();
	}
}
