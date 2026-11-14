import type { Context } from "../context/index.ts";
import type { Address, KindShape } from "../contracts/index.ts";
import type { Draft } from "../delta/index.ts";
import type { Watch, Watchable, WatchHandle } from "../watch.ts";
import type { JsonObject, StateDefinition } from "./definition.ts";
import type { SealToken } from "./fence.ts";
import type { KeyedSlot, KeySource } from "./keyed-slot.ts";
import type { SingletonSlot } from "./slot.ts";

export interface SingletonHandle<T extends JsonObject> extends Watchable<T> {
	change<R>(fn: (draft: Draft<T>) => R, context: Context): Promise<R>;
	retire(context: Context): Promise<void>;
}
export interface KeyedHandle<T extends JsonObject, Key = string> {
	get(key: Key, context: Context): Promise<T | undefined>;
	keys(context: Context): AsyncIterable<Key>;
	watch(key: Key, context: Context): Promise<WatchHandle<T> | undefined>;
	at(key: Key): Watchable<T>;
	change<R>(key: Key, fn: (draft: Draft<T>) => R, context: Context): Promise<R>;
	retire(key: Key, context: Context): Promise<void>;
}
export type HandleOf<D> = D extends StateDefinition<infer T, infer K, boolean>
	? K extends true
		? KeyedHandle<T>
		: K extends KindShape
			? KeyedHandle<T, Address<K>>
			: SingletonHandle<T>
	: never;
export interface KeyDeclarer {
	at(slot: KeyedSlot, key: string): KeySource;
}

export class Singleton implements SingletonHandle<JsonObject> {
	readonly slot: SingletonSlot;
	readonly token: SealToken;
	readonly version: number;
	constructor(slot: SingletonSlot, token: SealToken, version: number) {
		this.slot = slot;
		this.token = token;
		this.version = version;
	}
	get value(): JsonObject {
		this.slot.definition.assertVersion(this.version);
		return this.slot.value;
	}
	async watch(context: Context): Promise<Watch<JsonObject>> {
		this.slot.definition.assertVersion(this.version);
		return this.slot.openWatch(context) as Watch<JsonObject>;
	}
	change<R>(fn: (draft: Draft<JsonObject>) => R, context: Context): Promise<R> {
		return this.slot.owner.tx(async (tx) => fn(await tx.draft(this)), this.token, context);
	}
	retire(context: Context): Promise<void> {
		return this.slot.owner.tx((tx) => tx.retire(this), this.token, context);
	}
}
export class Keyed implements KeyedHandle<JsonObject, unknown> {
	readonly slot: KeyedSlot;
	readonly token: SealToken;
	readonly version: number;
	readonly #declarer: KeyDeclarer;
	constructor(slot: KeyedSlot, token: SealToken, version: number, declarer: KeyDeclarer) {
		this.slot = slot;
		this.token = token;
		this.version = version;
		this.#declarer = declarer;
	}
	get(key: unknown, context: Context): Promise<JsonObject | undefined> {
		try {
			return this.slot.get(this.slot.keyOf(key), this, context);
		} catch (error) {
			return Promise.reject(error);
		}
	}
	keys(context: Context): AsyncIterable<unknown> {
		return this.slot.handleKeys(this, context);
	}
	async watch(key: unknown, context: Context): Promise<Watch<JsonObject> | undefined> {
		return this.slot.watch(this.slot.keyOf(key), this, context);
	}
	at(key: unknown): Watchable<JsonObject> {
		return this.#declarer.at(this.slot, this.slot.keyOf(key)) as unknown as Watchable<JsonObject>;
	}
	change<R>(key: unknown, fn: (draft: Draft<JsonObject>) => R, context: Context): Promise<R> {
		return this.slot.owner.tx(async (tx) => fn(await tx.draft(this, key)), this.token, context);
	}
	retire(key: unknown, context: Context): Promise<void> {
		return this.slot.owner.tx((tx) => tx.retire(this, key), this.token, context);
	}
}
