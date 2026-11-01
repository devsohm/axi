import type { Context } from "../../context/index.ts";
import { PendingOps, track, type Op, type Prepared, type Tracker } from "../../delta/index.ts";
import { ObjectsError } from "../data/index.ts";
import type { CommitPersistence, JsonObject, StateDefinition } from "../documents/index.ts";
import {
	SlotDefinition,
	storedAfter,
	type DocumentChange,
	type DocumentSlot,
	type Documents,
	type Held,
	type PersistedSlot,
	type Persistence,
	type Stored,
	type StoredChange,
} from "../documents/internal.ts";
import { changeDocument, createDocument, type DocumentContent } from "../store/engine.ts";
import type { StagedWrite } from "../store/step.ts";

type HeldState = {
	readonly pending: PendingOps;
	base: boolean;
	deadline: number;
};
export type RunStatesOwner = {
	readonly documents: Documents;
	changed(id: string, ops: readonly Op[]): void;
	held(deadline: number): void;
};
export class RunStates implements DocumentSlot, PersistedSlot {
	readonly owner: Documents;
	readonly persisted: PersistedSlot | undefined;
	definition: SlotDefinition;
	readonly #older = new Map<string, SlotDefinition>();
	readonly #disk: Persistence | undefined;
	readonly #callbacks: RunStatesOwner;
	readonly #trackers = new Map<string, Tracker<JsonObject>>();
	readonly #stored = new Map<string, Stored>();
	readonly #held = new Map<string, HeldState>();
	constructor(
		definition: StateDefinition<JsonObject, false, boolean>,
		states: RunStatesOwner,
		persistence: Persistence | undefined,
	) {
		this.definition = new SlotDefinition(definition);
		this.owner = states.documents;
		this.#callbacks = states;
		this.#disk = persistence;
		this.persisted = persistence ? this : undefined;
	}
	redefine(definition: StateDefinition<JsonObject, false, boolean>): void {
		if (definition === this.definition.current) return;
		this.definition.check(definition);
		if (definition.version !== this.definition.current.version)
			for (const id of this.#trackers.keys()) if (!this.#older.has(id)) this.#older.set(id, this.definition);
		this.definition = new SlotDefinition(definition);
	}
	migrated(id: string, context: Context): JsonObject | undefined {
		const value = this.value(id),
			old = this.#older.get(id);
		return value === undefined || old === undefined
			? value
			: this.definition.current.migrate(value, old.current.version, context);
	}
	#definitionOf(key: string): SlotDefinition {
		return this.#older.get(key) ?? this.definition;
	}
	get persistence(): Persistence {
		return this.#disk!;
	}
	value(id: string): JsonObject | undefined {
		return this.#trackers.get(id)?.value;
	}
	current(key: string): Tracker<JsonObject> | undefined {
		return this.#trackers.get(key);
	}
	initial(_context: Context): JsonObject {
		throw new ObjectsError({
			code: "released",
			reason: "settled",
			message: `${this.definition.current.name}: the run's document is retired`,
		});
	}
	cold(_key: string): boolean {
		return false;
	}
	stored(key: string): Stored | undefined {
		return this.#stored.get(key);
	}
	load(_key: string, _context: Context): Promise<void> {
		return Promise.resolve();
	}
	stage(
		key: string,
		change: DocumentChange,
		was: Stored | undefined,
		writes: StagedWrite[],
		persistence: CommitPersistence,
	): StoredChange {
		if (persistence.kind === "deferred" && was && !change.retires && change.prepared)
			return {
				kind: "held",
				stored: was,
				withinMs: persistence.withinMs ?? 1_000,
			};
		const held = this.#held.get(key);
		return this.persistence.stage(key, this.#definitionOf(key).current, was, change, writes, held && heldOps(held));
	}
	adopt(
		key: string,
		tracker: Tracker<JsonObject>,
		prepared: Prepared<JsonObject>,
		change: StoredChange | undefined,
	): void {
		tracker.adopt(prepared);
		if (change?.kind === "held") this.#hold(key, prepared, change);
		else if (change) this.#settle(key, storedAfter(change));
		this.#callbacks.changed(key, prepared.ops);
	}
	retire(key: string): void {
		this.#older.delete(key);
		this.#trackers.delete(key);
		this.#stored.delete(key);
		this.#held.delete(key);
	}
	create(id: string, value: JsonObject, stored: Stored | undefined): void {
		this.#trackers.set(id, track(value));
		if (stored) this.#stored.set(id, stored);
	}
	stageCreate(id: string, value: JsonObject, writes: () => StagedWrite[]): () => void {
		const disk = this.#disk;
		if (!disk) return () => this.create(id, value, undefined);
		const { version, fingerprint } = this.definition.current,
			created = { id: 0 };
		writes().push(
			createDocument(disk.at(id), { version, fingerprint, value }, JSON.stringify(value), (id) => {
				created.id = id;
			}),
		);
		return () =>
			this.create(id, value, {
				id: created.id,
				revision: 1,
				version,
				deltasSinceBase: 0,
			});
	}
	deadline(id: string): number {
		return this.#held.get(id)?.deadline ?? Infinity;
	}
	get heldIds(): readonly string[] {
		return [...this.#held.keys()];
	}
	stageHeld(id: string, writes: StagedWrite[]): (() => void) | undefined {
		const held = this.#held.get(id),
			stored = this.#stored.get(id),
			tracker = this.#trackers.get(id);
		if (!held || !stored || !tracker) return undefined;
		const { version, fingerprint } = this.#definitionOf(id).current,
			value = tracker.value,
			pending = heldOps(held);
		const base = pending.base || stored.version !== version;
		const content: DocumentContent = base
			? { kind: "base", version, fingerprint, value }
			: { kind: "delta", version, ops: pending.ops };
		writes.push(changeDocument(stored.id, stored.revision, content, JSON.stringify(base ? value : pending.ops)));
		const next: Stored = {
			id: stored.id,
			revision: stored.revision + 1,
			version,
			deltasSinceBase: base ? 0 : stored.deltasSinceBase + 1,
		};
		return () => {
			if (this.#held.get(id) === held) this.#settle(id, next);
		};
	}
	drop(): void {
		this.#older.clear();
		this.#trackers.clear();
		this.#stored.clear();
		this.#held.clear();
	}
	#settle(key: string, stored: Stored | undefined): void {
		if (stored) this.#stored.set(key, stored);
		else this.#stored.delete(key);
		this.#held.delete(key);
	}
	#hold(key: string, prepared: Prepared<JsonObject>, change: Extract<StoredChange, { kind: "held" }>): void {
		const held = this.#held.get(key) ?? {
			pending: new PendingOps(),
			base: false,
			deadline: Infinity,
		};
		const count = change.stored.deltasSinceBase + (held.pending.size ? 1 : 0);
		if (
			this.#definitionOf(key).current.checkpointWhen(prepared.value, prepared.ops, {
				deltasSinceBase: count,
			})
		)
			held.base = true;
		if (held.base) held.pending.take();
		else held.pending.push(prepared.ops);
		held.deadline = Math.min(held.deadline, Date.now() + change.withinMs);
		this.#held.set(key, held);
		if (Number.isFinite(held.deadline)) this.#callbacks.held(held.deadline);
	}
}
const baseOnly: Held = { ops: [], base: true };
function heldOps(held: HeldState): Held {
	if (held.base) return baseOnly;
	const pending = held.pending.take();
	if (pending.kind === "replace") {
		held.base = true;
		return baseOnly;
	}
	// Reinsert the same array so a refused commit keeps the pending changes.
	held.pending.push(pending.ops);
	return { ops: pending.ops, base: false };
}
