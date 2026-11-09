import { awaitWithContext, BACKGROUND_CONTEXT, type Context } from "../context/index.ts";
import { ObjectsError } from "../data/index.ts";
import { asObjectsError } from "../data/internal.ts";
import type { Batch } from "../state/internal.ts";
import { MemberSource } from "./member-source.ts";
import type { PinnedKey, Target } from "./reference.ts";

type Owner = {
	readonly batch: Batch;
	readonly version: number;
	target(): Target | undefined;
	unavailable(): ObjectsError;
};
type Entry = {
	readonly member: string;
	readonly key: string;
	users: number;
	revision: number;
	instance: unknown;
	target?: Target;
	source?: MemberSource;
	pin?: PinnedKey;
	loading?: Promise<void>;
};

export class HeldKeys {
	readonly #owner: Owner;
	readonly #entries = new Map<string, Map<string, Entry>>();
	constructor(owner: Owner) {
		this.#owner = owner;
	}
	async pin(member: string, key: string, context: Context): Promise<PinnedKey> {
		let keys = this.#entries.get(member);
		if (keys === undefined) {
			keys = new Map();
			this.#entries.set(member, keys);
		}
		let entry = keys.get(key);
		if (entry === undefined) {
			entry = { member, key, users: 0, revision: 0, instance: undefined };
			keys.set(key, entry);
		}
		entry.users++;
		const held = entry;
		let open = true;
		const release = () => {
			if (open) {
				open = false;
				this.#release(held);
			}
		};
		try {
			if (entry.pin === undefined && !(entry.source && !this.#owner.target()?.hydrated))
				await awaitWithContext(this.#load(entry), context);
			if (entry.source === undefined) throw this.#owner.unavailable();
			return { source: entry.source, release };
		} catch (error) {
			release();
			throw error;
		}
	}
	follow(context: Context): void {
		const target = this.#owner.target();
		for (const keys of this.#entries.values())
			for (const entry of keys.values()) {
				if (target?.hydrated) {
					if (entry.instance !== (target.instance ?? target)) void this.#load(entry).catch(() => {});
				} else if (!(target?.lastValues && entry.target === target)) {
					if (target?.state.kind === "failed") entry.source?.fail(target.state.cause.error, context);
					else entry.source?.freeze();
					this.#unpin(entry);
				}
			}
	}
	end(error: ObjectsError): void {
		for (const keys of this.#entries.values())
			for (const entry of keys.values()) {
				entry.source?.objectEnded(error);
				this.#unpin(entry);
			}
		this.#entries.clear();
	}
	freeze(): void {
		for (const keys of this.#entries.values())
			for (const entry of keys.values()) {
				entry.source?.freeze();
				this.#unpin(entry);
			}
	}
	#load(entry: Entry): Promise<void> {
		const target = this.#owner.target();
		if (!target?.hydrated) return Promise.reject(this.#owner.unavailable());
		const instance = target.instance ?? target;
		if (entry.instance === instance && entry.loading !== undefined) return entry.loading;
		const revision = ++entry.revision;
		entry.instance = instance;
		entry.target = target;
		entry.source?.freeze();
		const loaded = target.pinKey(entry.member, entry.key, BACKGROUND_CONTEXT, this.#owner.version).then(
			(pin) => {
				if (entry.revision !== revision || !entry.users) {
					pin.release();
					return;
				}
				const old = entry.pin;
				entry.pin = pin;
				this.#owner.batch.within(() => {
					if (entry.source === undefined) entry.source = new MemberSource(pin.source, this.#owner.batch);
					else entry.source.bind(pin.source);
				}, BACKGROUND_CONTEXT);
				old?.release();
			},
			(error: unknown) => {
				if (entry.revision === revision) {
					entry.instance = undefined;
					entry.loading = undefined;
					this.#owner.batch.within(
						() => entry.source?.fail(asObjectsError(error, target.label), BACKGROUND_CONTEXT),
						BACKGROUND_CONTEXT,
					);
				}
				throw error;
			},
		);
		entry.loading = loaded;
		return loaded;
	}
	#unpin(entry: Entry): void {
		entry.revision++;
		entry.pin?.release();
		entry.pin = undefined;
		entry.instance = undefined;
		entry.target = undefined;
		entry.loading = undefined;
	}
	#release(entry: Entry): void {
		if (--entry.users > 0) return;
		const keys = this.#entries.get(entry.member);
		if (keys?.get(entry.key) !== entry) return;
		keys.delete(entry.key);
		if (!keys.size) this.#entries.delete(entry.member);
		entry.source?.objectEnded(
			new ObjectsError({ code: "released", message: `${entry.member}.at(${entry.key}): released` }),
		);
		this.#unpin(entry);
	}
}
