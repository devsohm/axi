import type { Context } from "../context/index.ts";
import { track, type Prepared, type Tracker } from "../delta/index.ts";
import { ObjectsError } from "../data/index.ts";
import type { StagedWrite } from "../store/step.ts";
import { AddressSource } from "./address-source.ts";
import type {
	CommitPersistence,
	JsonObject,
	StateDefinition,
} from "./definition.ts";
import type { Documents } from "./documents.ts";
import type { SealToken } from "./fence.ts";
import {
	storedAfter,
	type DocumentChange,
	type Persistence,
	type Stored,
	type StoredChange,
} from "./persistence.ts";

export type AnyDefinition = StateDefinition<JsonObject, boolean, boolean>;
export interface DocumentSlot {
	readonly owner: Documents;
	readonly persisted: PersistedSlot | undefined;
	current(key: string): Tracker<JsonObject> | undefined;
	initial(context: Context): JsonObject;
	adopt(
		key: string,
		tracker: Tracker<JsonObject>,
		prepared: Prepared<JsonObject>,
		stored: StoredChange | undefined,
	): void;
	retire(key: string): void;
}
export interface PersistedSlot {
	readonly persistence: Persistence;
	readonly definition: SlotDefinition;
	cold(key: string): boolean;
	stored(key: string): Stored | undefined;
	stage(
		key: string,
		change: DocumentChange,
		was: Stored | undefined,
		writes: StagedWrite[],
		persistence: CommitPersistence,
	): StoredChange;
	load(key: string, context: Context, token?: SealToken): Promise<void>;
}
export class SlotDefinition {
	#definition: AnyDefinition;
	#ready = false;
	constructor(definition: AnyDefinition) {
		this.#definition = definition;
	}
	get current(): AnyDefinition {
		return this.#definition;
	}
	get hydrated(): AnyDefinition | undefined {
		return this.#ready ? this.#definition : undefined;
	}
	check(next: AnyDefinition): void {
		const current = this.#definition,
			name = current.name;
		if (current.keyed !== next.keyed)
			throw new Error(
				`${name}: declared ${next.keyed ? "keyed" : "singleton"}, its documents are not`,
			);
		if (current.persist !== next.persist)
			throw new Error(
				`${name}: declared ${next.persist ? "persisted" : "in memory"}, its documents are not`,
			);
		if (next.version < current.version)
			throw new Error(
				`${name}: version ${next.version} is older than its documents' (${current.version})`,
			);
		if (
			next.version === current.version &&
			next.fingerprint !== current.fingerprint
		)
			throw new Error(
				`${name}: the schema changed without a version bump (version ${current.version})`,
			);
	}
	hydrate(definition: AnyDefinition): void {
		this.#definition = definition;
		this.#ready = true;
	}
	assertVersion(version: number): void {
		const current = this.#definition;
		if (version === current.version) return;
		const message = `${current.name}: a handle of version ${version}; the documents are at version ${current.version}`;
		if (version > current.version)
			throw new ObjectsError({
				code: "not_ready",
				message: `${message} until the activation migrates them`,
			});
		throw new ObjectsError({ code: "released", reason: "version", message });
	}
}
export class SingletonSlot
	extends AddressSource
	implements DocumentSlot, PersistedSlot
{
	readonly owner: Documents;
	readonly definition: SlotDefinition;
	readonly persisted: PersistedSlot | undefined;
	readonly #disk: Persistence | undefined;
	#initial: JsonObject | undefined;
	#tracker: Tracker<JsonObject> | undefined;
	#stored: Stored | undefined;
	#loaded: boolean;
	constructor(
		owner: Documents,
		definition: AnyDefinition,
		persistence: Persistence | undefined,
	) {
		super(owner.batch);
		this.owner = owner;
		this.definition = new SlotDefinition(definition);
		this.#disk = persistence;
		this.#loaded = persistence === undefined;
		this.persisted = persistence ? this : undefined;
	}
	get persistence(): Persistence {
		return this.#disk!;
	}
	get value(): JsonObject {
		this.owner.assertLive();
		if (!this.#initial || !this.#loaded)
			throw new ObjectsError({
				code: "not_ready",
				message: `${this.definition.current.name}: read before activation`,
			});
		return this.#tracker?.value ?? this.#initial;
	}
	hydrate(next: AnyDefinition, context: Context): void {
		const previous = this.definition.hydrated;
		if (previous?.version === next.version) {
			this.definition.hydrate(next);
			return;
		}
		const before = previous && this.#loaded ? this.value : undefined;
		const tracker =
			this.#tracker && previous
				? track(next.migrate(this.#tracker.value, previous.version, context))
				: this.#tracker;
		this.#initial = next.initial(context);
		this.#tracker = tracker;
		this.definition.hydrate(next);
		if (before) this.batch.commit(() => this.replaced(), context);
	}
	async load(_key: string, context: Context): Promise<void> {
		if (this.#loaded) return;
		const document = await this.persistence.read("", context);
		if (document) {
			const loaded = this.persistence.decode(
				document,
				this.definition.current,
				context,
			);
			this.#tracker = track(loaded.value);
			this.#stored = loaded.stored;
		}
		this.#loaded = true;
	}
	loadDeclared(context: Context): Promise<void> {
		return this.load("", context);
	}
	key(_key: string): string {
		return "";
	}
	cold(_key: string): boolean {
		return false;
	}
	stored(_key: string): Stored | undefined {
		return this.#stored;
	}
	stage(
		key: string,
		change: DocumentChange,
		was: Stored | undefined,
		writes: StagedWrite[],
	): StoredChange {
		return this.persistence.stage(
			key,
			this.definition.current,
			was,
			change,
			writes,
		);
	}
	current(_key: string): Tracker<JsonObject> | undefined {
		return this.#tracker;
	}
	initial(_context: Context): JsonObject {
		return this.#initial!;
	}
	adopt(
		_key: string,
		tracker: Tracker<JsonObject>,
		prepared: Prepared<JsonObject>,
		stored: StoredChange | undefined,
	): void {
		const before = this.#tracker?.value ?? this.#initial!;
		tracker.adopt(prepared);
		this.#tracker = tracker;
		this.#stored = stored ? storedAfter(stored) : undefined;
		this.written(before, prepared);
	}
	retire(_key: string): void {
		this.#tracker = undefined;
		this.#stored = undefined;
		this.retired(this.#initial!);
	}
	drop(): void {
		this.#tracker = undefined;
		this.#stored = undefined;
		this.endWatches();
	}
}
