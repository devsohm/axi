import type { TSchema } from "typebox";
import {
	type Draft,
	diffRevisions,
	type JsonValue,
	type Op,
	type Prepared,
	type Tracker,
	track,
} from "./delta/index.ts";
import { ChordError } from "./errors.ts";
import { enqueue, holdPublications } from "./publish.ts";
import { assertValid } from "./schema.ts";
import type { Ctx, Readable, StateEvent } from "./types.ts";

export interface SourceOptions {
	readonly dev: boolean;
	readonly report: (error: unknown) => void;
}
export type WriteGuard = (ctx: Ctx) => void;
export const HYDRATION: unique symbol = Symbol("hydration");
export interface Hydration {
	readonly hydrated: boolean;
	whenHydrated(): Promise<void>;
}
export function hydrationOf(value: unknown): Hydration | undefined {
	return value !== null && typeof value === "object"
		? (value as { readonly [HYDRATION]?: Hydration })[HYDRATION]
		: undefined;
}
export function unhydrated(sources: Iterable<unknown>): Hydration[] {
	return [...sources].map(hydrationOf).filter((item): item is Hydration => item?.hydrated === false);
}
export const notReady = (what: string): ChordError => new ChordError("not_ready", `${what} is not ready`);

class Observers<T> {
	readonly values = new Set<(value: T) => void>();
	readonly events = new Set<(event: StateEvent<T>) => void>();
	readonly report: (error: unknown) => void;
	constructor(report: (error: unknown) => void) {
		this.report = report;
	}
	subscribe(listener: (value: T) => void, value: T): () => void {
		this.values.add(listener);
		this.call(listener, value);
		return () => this.values.delete(listener);
	}
	eventsFor(listener: (event: StateEvent<T>) => void, value: T): () => void {
		this.events.add(listener);
		this.call(listener, { type: "snap", value });
		return () => this.events.delete(listener);
	}
	call<V>(listener: (value: V) => void, value: V): void {
		try {
			listener(value);
		} catch (error) {
			this.report(error);
		}
	}
	emit(event: StateEvent<T>): void {
		const events = [...this.events],
			values = [...this.values];
		enqueue(() => {
			for (const fn of events) if (this.events.has(fn)) this.call(fn, event);
			for (const fn of values) if (this.values.has(fn)) this.call(fn, event.value);
		});
	}
}

let sequence = 0;
export abstract class Source<T> implements Readable<T> {
	readonly seq = ++sequence;
	readonly dependents = new Set<Derived<unknown>>();
	schemas: readonly TSchema[] = [];
	protected readonly fanout: Observers<T>;
	readonly key: string;
	protected readonly options: SourceOptions;
	constructor(key: string, options: SourceOptions) {
		this.key = key;
		this.options = options;
		this.fanout = new Observers(options.report);
	}
	abstract get value(): T;
	subscribe(listener: (value: T) => void): () => void {
		return this.fanout.subscribe(listener, this.value);
	}
	events(listener: (event: StateEvent<T>) => void): () => void {
		return this.fanout.eventsFor(listener, this.value);
	}
	protected ownSchemas(): readonly TSchema[] {
		return [];
	}
	validate(value: unknown): void {
		if (!this.options.dev) return;
		for (const schema of this.ownSchemas()) assertValid("state", `state ${this.key}`, schema, value);
		for (const schema of this.schemas) assertValid("state", `state ${this.key}`, schema, value);
	}
}

function candidates(changed: Source<unknown>, value: unknown, validate = true): Map<Derived<unknown>, unknown> {
	const affected = new Set<Derived<unknown>>();
	function visit(source: Source<unknown>): void {
		for (const derived of source.dependents)
			if (!affected.has(derived)) {
				affected.add(derived);
				visit(derived);
			}
	}
	visit(changed);
	const staged = new Map<Readable<unknown>, unknown>([[changed, value]]);
	const result = new Map<Derived<unknown>, unknown>();
	for (const derived of [...affected].sort((a, b) => a.seq - b.seq)) {
		const next = derived.compute((source) => (staged.has(source) ? staged.get(source) : source.value));
		if (validate) derived.validate(next);
		staged.set(derived, next);
		result.set(derived, next);
	}
	return result;
}

function valueOps(ops: readonly Op[], value: unknown): Op[] {
	const result: Op[] = [];
	for (const op of ops) {
		if (op[0] === "r" || !op[1].length) return [["r", value as JsonValue]];
		const path = op[1].slice(1);
		if (op[0] === "p") result.push(["p", path, op[2], op[3], op[4]]);
		else if (op[0] === "m") result.push(["m", path, op[2]]);
		else if (!path.length) return [["r", value as JsonValue]];
		else {
			const nonempty: [string | number, ...(string | number)[]] = [path[0], ...path.slice(1)];
			if (op[0] === "d") result.push(["d", nonempty]);
			else result.push([op[0], nonempty, op[2]] as Op);
		}
	}
	return result;
}

function sharesStructure(before: unknown, value: unknown): boolean {
	if (before === null || value === null || typeof before !== "object" || typeof value !== "object" || before === value)
		return false;
	if (Array.isArray(before) !== Array.isArray(value)) return false;
	for (const [key, child] of Object.entries(value))
		if (child !== null && typeof child === "object" && Reflect.get(before, key) === child) return true;
	return false;
}

export class Cell<T> extends Source<T> {
	#tracker: Tracker<{ v: T }>;
	#initialized: boolean;
	schema: TSchema;
	readonly #guard: WriteGuard;
	constructor(
		key: string,
		schema: TSchema,
		initial: { readonly value: T } | undefined,
		guard: WriteGuard,
		options: SourceOptions,
	) {
		super(key, options);
		this.schema = schema;
		this.#guard = guard;
		if (initial !== undefined) assertValid("state", `initial value of state ${key}`, schema, initial.value);
		this.#initialized = initial !== undefined;
		this.#tracker = track({ v: (initial?.value ?? null) as T });
	}
	get value(): T {
		this.#check();
		return this.#tracker.value.v;
	}
	#check(): void {
		if (!this.#initialized) throw notReady(`state ${this.key} (its init has not run)`);
	}
	protected override ownSchemas(): readonly TSchema[] {
		return [this.schema];
	}
	initialize(value: T): void {
		if (this.#initialized) throw new Error(`state ${this.key} is already initialized`);
		assertValid("state", `initial value of state ${this.key}`, this.schema, value);
		this.#tracker = track({ v: value });
		this.#initialized = true;
	}
	change(ctx: Ctx, fn: (draft: Draft<T>) => T): void;
	change(ctx: Ctx, fn: (draft: Draft<T>) => void): void;
	change(ctx: Ctx, fn: (draft: Draft<T>) => unknown): void {
		this.#guard(ctx);
		this.#check();
		const change = this.#tracker.beginChange();
		let prepared: Prepared<{ v: T }>;
		try {
			const draft = change.state;
			const returned = fn(draft.v as Draft<T>);
			if (returned instanceof Promise) throw new TypeError("cell.change callbacks must be synchronous");
			if (returned !== undefined) {
				if (returned !== draft.v) assertValid("state", `state ${this.key}`, this.schema, returned);
				draft.v = returned as Draft<T>;
			}
			prepared = change.prepare();
		} catch (error) {
			change.abort();
			throw error;
		}
		this.#commit(prepared, "ops");
	}
	replace(ctx: Ctx, value: T, options: { readonly diff?: boolean } = {}): void {
		this.#guard(ctx);
		this.#check();
		const before = this.value;
		const diff = options.diff ?? sharesStructure(before, value);
		const ops = diff ? diffRevisions(before as JsonValue, value as JsonValue) : undefined;
		this.#commit(this.#tracker.prepareReplace({ v: value }), "ops", true, ops);
	}
	reset(value: T, schema: TSchema): void {
		this.schema = schema;
		this.#commit(this.#tracker.prepareReplace({ v: value }), "reset", false);
	}
	#commit(prepared: Prepared<{ v: T }>, kind: "ops" | "reset", validate = true, explicit?: readonly Op[]): void {
		if (kind === "ops" && !prepared.ops.length) {
			this.#tracker.adopt(prepared);
			return;
		}
		const value = prepared.value.v;
		let derived: Map<Derived<unknown>, unknown>;
		try {
			if (validate) this.validate(value);
			derived = candidates(this as Source<unknown>, value, validate);
		} catch (error) {
			prepared.abort();
			throw error;
		}
		holdPublications(() => {
			this.#tracker.adopt(prepared);
			const ops = explicit !== undefined && explicit.length > 0 ? explicit : valueOps(prepared.ops, value);
			this.fanout.emit(
				kind === "reset"
					? { type: kind, value }
					: {
							type: kind,
							ops,
							value,
						},
			);
			for (const [source, next] of derived) source.install(next);
		});
	}
}

export type Sources = readonly Readable<unknown>[];
export type SourceValues<S extends Sources> = { [K in keyof S]: S[K] extends Readable<infer T> ? T : never };
export class Derived<T> extends Source<T> {
	readonly sources: Sources;
	#value = undefined as T;
	readonly #unsubscribes: (() => void)[] = [];
	readonly #fn: (...values: never[]) => unknown;
	constructor(key: string, sources: Sources, fn: (...values: never[]) => unknown, options: SourceOptions) {
		super(key, options);
		this.#fn = fn;
		this.sources = sources.map((source) => {
			if (
				source === null ||
				typeof source !== "object" ||
				typeof source.subscribe !== "function" ||
				!("value" in source)
			)
				throw new TypeError(`derive ${key}: sources must be readables`);
			return source;
		});
	}
	get value(): T {
		return this.#value;
	}
	get [HYDRATION](): Hydration | undefined {
		const pending = unhydrated(this.sources);
		return pending.length
			? { hydrated: false, whenHydrated: () => Promise.all(pending.map((item) => item.whenHydrated())).then(() => {}) }
			: undefined;
	}
	attach(precomputed?: ReadonlyMap<unknown, unknown>): void {
		this.#value = precomputed?.has(this) ? (precomputed.get(this) as T) : this.compute((source) => source.value);
		for (const source of this.sources) {
			if (source instanceof Source) source.dependents.add(this as Derived<unknown>);
			else this.#unsubscribes.push(source.subscribe(() => this.refresh()));
		}
	}
	detach(): void {
		for (const source of this.sources) if (source instanceof Source) source.dependents.delete(this as Derived<unknown>);
		for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe();
	}
	compute(read: (source: Readable<unknown>) => unknown): T {
		const result = this.#fn(...(this.sources.map(read) as never[]));
		if (result instanceof Promise) throw new TypeError(`derive ${this.key}: fn must be synchronous`);
		return result as T;
	}
	refresh(): void {
		try {
			const value = this.compute((source) => source.value),
				derived = candidates(this as Source<unknown>, value);
			holdPublications(() => {
				this.install(value);
				for (const [source, next] of derived) source.install(next);
			});
		} catch (error) {
			this.options.report(error);
		}
	}
	install(next: T): void {
		const before = this.#value;
		this.#value = next;
		const ops: Op[] =
			before === undefined || next === undefined
				? [["r", (next ?? null) as JsonValue]]
				: diffRevisions(before as JsonValue, next as JsonValue);
		if (ops.length) this.fanout.emit({ type: "ops", ops, value: next });
	}
}
export const isSource = (value: unknown): value is Cell<unknown> | Derived<unknown> => value instanceof Source;
