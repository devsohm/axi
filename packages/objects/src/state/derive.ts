import type { Context } from "../context/index.ts";
import { diffRevisions, type Op } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import type { Batch } from "./batch.ts";
import { NativeSource } from "./native-source.ts";
import { type Constant, type Dependent, handedOut, Source, type WatchStart } from "./watchable.ts";

export type DeriveSource = Source | Constant;
export type DeriveInput = DeriveSource | NativeSource;
type Status = { kind: "dirty" } | { kind: "clean"; value: JsonValue } | { kind: "failed" | "detached"; error: unknown };
const missing = Symbol("uncomputed");

export class Derive extends Source implements Dependent {
	readonly #compute: (values: readonly unknown[]) => JsonValue;
	#declared: readonly unknown[] | undefined;
	#sources: readonly DeriveInput[] = [];
	#status: Status = { kind: "dirty" };
	#previous: JsonValue | typeof missing | undefined;
	#last: JsonValue | typeof missing = missing;
	#retired = false;
	#failing = false;
	#report: ((error: unknown) => void) | undefined;
	constructor(sources: readonly unknown[], compute: (values: readonly unknown[]) => JsonValue, batch: Batch) {
		super(batch);
		this.#declared = sources;
		this.#compute = compute;
	}
	get value(): JsonValue {
		if (this.#status.kind === "clean") return this.#status.value;
		if (this.#status.kind !== "dirty") throw this.#status.error;
		return this.batch.compute(() => {
			try {
				this.batch.count("objects.derive.computes");
				const inputs = this.#sources.map((source) => source.value);
				let value: JsonValue;
				try { value = this.#compute(inputs) } catch (error) {
					if (!this.#failing) this.#report?.(handedOut(error));
					this.#failing = true;
					throw error;
				}
				this.#failing = false;
				this.#last = value;
				this.#status = { kind: "clean", value };
				return value;
			} catch (error) { this.#status = { kind: "failed", error }; throw error }
		});
	}
	override start(): WatchStart {
		try { return { kind: "value", value: this.value } } catch (error) {
			if (this.#status.kind !== "failed") throw error;
			return { kind: "failed", error, last: this.#last === missing ? undefined : this.#last };
		}
	}
	attach(resolve: (source: unknown, index: number) => DeriveInput, report: (error: unknown) => void): void {
		this.#report = report;
		this.#sources = (this.#declared ?? []).map(resolve);
		this.#declared = undefined;
		for (const source of this.#sources) if (source instanceof Source || source instanceof NativeSource) source.dependents.add(this);
	}
	detach(error: Error): void {
		for (const source of this.#sources) if (source instanceof Source || source instanceof NativeSource) source.dependents.delete(this);
		this.#sources = [];
		this.#declared = undefined;
		this.#status = { kind: "detached", error };
		this.#previous = undefined;
		this.endWatches();
	}
	invalidate(): void {
		const current = this.#status;
		if (current.kind === "dirty" || current.kind === "detached") return;
		if (this.watched) this.#previous = current.kind === "clean" ? current.value : missing;
		this.#status = { kind: "dirty" };
		this.changed();
	}
	sourceRetired(visited: Set<Dependent>): void {
		if (visited.has(this)) return;
		visited.add(this);
		if (this.watched) this.#retired = true;
		for (const dependent of this.dependents) dependent.sourceRetired(visited);
	}
	deliver(context: Context): void {
		const before = this.#previous;
		this.#previous = undefined;
		let after: JsonValue;
		try { after = this.value } catch (error) {
			if (before !== missing) this.failWatches(error, context);
			return;
		}
		const retired = this.#retired;
		this.#retired = false;
		let ops: readonly Op[] = [];
		if (after !== before) {
			this.batch.count("objects.derive.diffs");
			ops = before === missing || before === undefined ? [["r", after]] : diffRevisions(before, after);
		}
		if (retired || ops.length) this.publish(after, ops, retired, context);
	}
}

export function mapShared<E, R extends JsonValue>(map: (element: E) => R): (elements: readonly E[]) => R[] {
	const cache = new WeakMap<object, R>();
	return (elements) => elements.map((element) => {
		if (typeof element !== "object" || element === null) return map(element);
		const saved = cache.get(element);
		if (saved !== undefined) return saved;
		const result = map(element);
		cache.set(element, result);
		return result;
	});
}
