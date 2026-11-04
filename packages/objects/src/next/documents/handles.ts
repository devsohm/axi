import type { Context } from "../../context/index.ts";
import type { Draft } from "../../delta/index.ts";
import type { Watch, Watchable, WatchHandle } from "../../watch.ts";
import type { JsonObject, StateDefinition } from "./definition.ts";
import type { SealToken } from "./fence.ts";
import type { KeyedSlot, KeySource } from "./keyed-slot.ts";
import type { SingletonSlot } from "./slot.ts";

export interface SingletonHandle<T extends JsonObject> extends Watchable<T> {
	change<R>(fn: (draft: Draft<T>) => R, context: Context): Promise<R>;
	retire(context: Context): Promise<void>;
}
export interface KeyedHandle<T extends JsonObject> {
	get(key: string, context: Context): Promise<T | undefined>;
	keys(context: Context): AsyncIterable<string>;
	watch(key: string, context: Context): Promise<WatchHandle<T> | undefined>;
	at(key: string): Watchable<T>;
	change<R>(
		key: string,
		fn: (draft: Draft<T>) => R,
		context: Context,
	): Promise<R>;
	retire(key: string, context: Context): Promise<void>;
}
export type HandleOf<D> = D extends StateDefinition<infer T, infer K, boolean>
	? K extends true
		? KeyedHandle<T>
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
		return this.slot.owner.tx(
			async (tx) => fn(await tx.draft(this)),
			this.token,
			context,
		);
	}
	retire(context: Context): Promise<void> {
		return this.slot.owner.tx((tx) => tx.retire(this), this.token, context);
	}
}
export class Keyed implements KeyedHandle<JsonObject> {
	readonly slot: KeyedSlot;
	readonly token: SealToken;
	readonly version: number;
	readonly #declarer: KeyDeclarer;
	constructor(
		slot: KeyedSlot,
		token: SealToken,
		version: number,
		declarer: KeyDeclarer,
	) {
		this.slot = slot;
		this.token = token;
		this.version = version;
		this.#declarer = declarer;
	}
	get(key: string, context: Context): Promise<JsonObject | undefined> {
		return this.slot.get(key, this, context);
	}
	keys(context: Context): AsyncIterable<string> {
		return this.slot.keys(this, context);
	}
	watch(key: string, context: Context): Promise<Watch<JsonObject> | undefined> {
		return this.slot.watch(key, this, context);
	}
	at(key: string): Watchable<JsonObject> {
		return this.#declarer.at(
			this.slot,
			key,
		) as unknown as Watchable<JsonObject>;
	}
	change<R>(
		key: string,
		fn: (draft: Draft<JsonObject>) => R,
		context: Context,
	): Promise<R> {
		return this.slot.owner.tx(
			async (tx) => fn(await tx.draft(this, key)),
			this.token,
			context,
		);
	}
	retire(key: string, context: Context): Promise<void> {
		return this.slot.owner.tx(
			(tx) => tx.retire(this, key),
			this.token,
			context,
		);
	}
}
