import { awaitWithContext, type Context } from "../../context/index.ts";
import { track, type Tracker, type Prepared } from "../../delta/index.ts";
import type { Watch } from "../../watch.ts";
import { ObjectsError } from "../data/index.ts";
import { asObjectsError } from "../data/internal.ts";
import type { StagedWrite } from "../store/step.ts";
import { compareText, storedText } from "../store/text.ts";
import { AddressSource } from "./address-source.ts";
import type { JsonObject } from "./definition.ts";
import type { Documents } from "./documents.ts";
import type { SealToken } from "./fence.ts";
import {
	storedAfter,
	type Persistence,
	type DocumentChange,
	type StoredChange,
	type Stored,
	type Loaded,
} from "./persistence.ts";
import { Resident } from "./residency.ts";
import {
	SlotDefinition,
	type AnyDefinition,
	type DocumentSlot,
	type PersistedSlot,
} from "./slot.ts";

export type Access = { readonly token: SealToken; readonly version: number };
type SharedLoad = {
	readonly done: Promise<void>;
	readonly tokens: Set<SealToken>;
	refused: ReadonlySet<SealToken> | undefined;
};
const KEYS_PAGE = 100;
export class KeyedSlot implements DocumentSlot, PersistedSlot {
	readonly owner: Documents;
	readonly definition: SlotDefinition;
	readonly persisted: PersistedSlot | undefined;
	readonly #disk: Persistence | undefined;
	readonly #residents = new Map<string, Resident>();
	readonly #pins = new Map<string, KeySource>();
	readonly #loading = new Map<string, SharedLoad>();
	readonly #keyLabel: string;
	constructor(
		owner: Documents,
		definition: AnyDefinition,
		persistence: Persistence | undefined,
	) {
		this.owner = owner;
		this.definition = new SlotDefinition(definition);
		this.#disk = persistence;
		this.persisted = persistence ? this : undefined;
		this.#keyLabel = `${definition.name}: key`;
	}
	get persistence(): Persistence {
		return this.#disk!;
	}
	key(raw: string): string {
		return storedText(raw, this.#keyLabel);
	}
	get(
		raw: string,
		access: Access,
		context: Context,
	): Promise<JsonObject | undefined> {
		try {
			return this.#get(this.key(raw), access, context);
		} catch (error) {
			return Promise.reject(error);
		}
	}
	async #get(
		key: string,
		access: Access,
		context: Context,
	): Promise<JsonObject | undefined> {
		this.owner.assertLive();
		this.definition.assertVersion(access.version);
		const resident = this.#resident(key);
		if (resident) {
			this.#touch(resident);
			return resident.tracker.value;
		}
		if (!this.#disk) return undefined;
		this.owner.assertAdmitted(access.token);
		const load = this.#loading.get(key) ?? this.#startLoad(key);
		load.tokens.add(access.token);
		await awaitWithContext(load.done, context);
		if (load.refused?.has(access.token)) throw this.owner.released();
		return this.#residents.get(key)?.tracker.value;
	}
	async *keys(access: Access, context: Context): AsyncIterable<string> {
		this.owner.assertLive();
		this.definition.assertVersion(access.version);
		const disk = this.#disk;
		if (!disk) {
			yield* [...this.#residents.keys()].sort(compareText);
			return;
		}
		let after: string | undefined;
		for (;;) {
			const page = await this.owner.onLine(
				() => disk.keys(after, KEYS_PAGE, context),
				access.token,
			);
			yield* page;
			if (page.length < KEYS_PAGE) return;
			after = page.at(-1);
		}
	}
	async watch(
		raw: string,
		access: Access,
		context: Context,
	): Promise<Watch<JsonObject> | undefined> {
		const key = this.key(raw);
		if ((await this.#get(key, access, context)) === undefined) return undefined;
		const release = this.pin(key, context);
		if (!this.#residents.has(key)) {
			release();
			return undefined;
		}
		try {
			const watch = this.#pins
				.get(key)!
				.openWatch(context) as Watch<JsonObject>;
			void watch.closed.then(release);
			return watch;
		} catch (error) {
			release();
			throw error;
		}
	}
	pin(raw: string, context: Context): () => void {
		const key = this.key(raw);
		let source = this.#pins.get(key);
		if (!source) {
			source = new KeySource(
				this,
				key,
				this.definition.current.initial(context),
				!this.#disk || this.#residents.has(key),
			);
			this.#pins.set(key, source);
		}
		source.pins++;
		const resident = this.#residents.get(key);
		if (resident) this.owner.residency.forget(resident);
		const held = source;
		let open = true;
		return () => {
			if (!open) return;
			open = false;
			if (--held.pins || this.#pins.get(key) !== held) return;
			this.#pins.delete(key);
			const idle = this.#residents.get(key);
			if (idle) this.#touch(idle);
		};
	}
	source(key: string): KeySource {
		return this.#pins.get(this.key(key))!;
	}
	async ensure(raw: string, context: Context): Promise<void> {
		const key = this.key(raw);
		if (this.#pins.get(key)?.ready === false)
			await this.owner.onLine(() => this.load(key, context));
	}
	async loadDeclared(context: Context): Promise<void> {
		for (const [key, source] of this.#pins)
			if (!source.ready) await this.load(key, context);
	}
	async load(key: string, context: Context, token?: SealToken): Promise<void> {
		if (this.#residents.has(key)) return;
		const document = await this.persistence.read(key, context);
		if (token?.sealed) return;
		let loaded: Loaded | undefined;
		try {
			loaded =
				document &&
				this.persistence.decode(document, this.definition.current, context);
		} catch (error) {
			throw this.#fail(error);
		}
		if (loaded && !this.#residents.has(key)) {
			const resident = new Resident(
				this,
				key,
				track(loaded.value),
				loaded.stored,
				this.definition.current.version,
			);
			this.#residents.set(key, resident);
			this.#touch(resident);
		}
		const source = this.#pins.get(key);
		if (source) source.ready = true;
	}
	cold(key: string): boolean {
		return this.#disk !== undefined && !this.#residents.has(key);
	}
	stored(key: string): Stored | undefined {
		return this.#residents.get(key)?.stored;
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
	hydrate(definition: AnyDefinition, context: Context): void {
		const previous = this.definition.hydrated;
		this.definition.hydrate(definition);
		if (!previous || previous.version === definition.version) return;
		const migrated: [Resident, Tracker<JsonObject>][] = [];
		for (const key of this.#pins.keys()) {
			const resident = this.#residents.get(key);
			if (resident) migrated.push([resident, this.#migrate(resident, context)]);
		}
		for (const [resident, tracker] of migrated) {
			resident.tracker = tracker;
			resident.version = definition.version;
		}
		this.owner.batch.commit(() => {
			for (const source of this.#pins.values())
				source.retake(definition.initial(context));
		}, context);
	}
	current(key: string): Tracker<JsonObject> | undefined {
		return this.#resident(key)?.tracker;
	}
	initial(context: Context): JsonObject {
		return this.definition.current.initial(context);
	}
	adopt(
		key: string,
		tracker: Tracker<JsonObject>,
		prepared: Prepared<JsonObject>,
		change: StoredChange | undefined,
	): void {
		const source = this.#pins.get(key),
			before = source?.peek(),
			version = this.definition.current.version;
		tracker.adopt(prepared);
		const stored = change ? storedAfter(change) : undefined;
		let resident = this.#residents.get(key);
		if (!resident) {
			resident = new Resident(this, key, tracker, stored, version);
			this.#residents.set(key, resident);
		} else {
			resident.tracker = tracker;
			resident.stored = stored;
			resident.version = version;
		}
		if (source) source.written(before!, prepared);
		else this.#touch(resident);
	}
	retire(key: string): void {
		const resident = this.#residents.get(key);
		if (resident) {
			this.#residents.delete(key);
			this.owner.residency.forget(resident);
		}
		this.#pins.get(key)?.retire();
	}
	evict(resident: Resident): void {
		if (this.#residents.get(resident.key) === resident)
			this.#residents.delete(resident.key);
	}
	drop(): void {
		for (const resident of this.#residents.values())
			this.owner.residency.forget(resident);
		this.#residents.clear();
		for (const source of this.#pins.values()) source.end();
		this.#pins.clear();
	}
	#startLoad(key: string): SharedLoad {
		const tokens = new Set<SealToken>();
		const load: SharedLoad = {
			tokens,
			refused: undefined,
			done: this.owner.onLine(async () => {
				load.refused = new Set([...tokens].filter((token) => token.sealed));
				if (load.refused.size === tokens.size) throw this.owner.released();
				await this.load(key, this.owner.context);
			}),
		};
		this.#loading.set(key, load);
		const remove = (): void => {
			this.#loading.delete(key);
		};
		void load.done.then(remove, remove);
		return load;
	}
	#resident(key: string): Resident | undefined {
		const resident = this.#residents.get(key),
			version = this.definition.current.version;
		if (resident && resident.version !== version) {
			resident.tracker = this.#migrate(resident, this.owner.context);
			resident.version = version;
		}
		return resident;
	}
	#migrate(resident: Resident, context: Context): Tracker<JsonObject> {
		try {
			return track(
				this.definition.current.migrate(
					resident.tracker.value,
					resident.version,
					context,
				),
			);
		} catch (error) {
			throw this.#fail(error);
		}
	}
	#fail(error: unknown): ObjectsError {
		const failure = asObjectsError(error, this.owner.label);
		this.owner.fail(failure);
		return failure;
	}
	#touch(resident: Resident): void {
		if (this.#disk && !this.#pins.has(resident.key))
			this.owner.residency.touch(resident);
	}
}

export class KeySource extends AddressSource {
	readonly owner: Documents;
	readonly key: string;
	readonly #slot: KeyedSlot;
	pins = 0;
	ready: boolean;
	#initial: JsonObject;
	constructor(
		slot: KeyedSlot,
		key: string,
		initial: JsonObject,
		ready: boolean,
	) {
		super(slot.owner.batch);
		this.owner = slot.owner;
		this.#slot = slot;
		this.key = key;
		this.#initial = initial;
		this.ready = ready;
	}
	get value(): JsonObject {
		this.owner.assertLive();
		if (!this.ready)
			throw new ObjectsError({
				code: "not_ready",
				message: `${this.#slot.definition.current.name}(${this.key}): read before it was loaded`,
			});
		return this.peek();
	}
	peek(): JsonObject {
		return this.#slot.current(this.key)?.value ?? this.#initial;
	}
	retire(): void {
		this.retired(this.#initial);
	}
	retake(initial: JsonObject): void {
		this.#initial = initial;
		if (this.ready) this.replaced();
	}
	end(): void {
		this.endWatches();
	}
}
