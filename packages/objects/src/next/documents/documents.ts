import type { Context } from "../../context/index.ts";
import { ObjectsError } from "../data/index.ts";
import type { Batch } from "../state/internal.ts";
import type { ObjectsStore } from "../store/store.ts";
import type { CommitPersistence, JsonObject, StateDefinition } from "./definition.ts";
import { SealToken } from "./fence.ts";
import { Keyed, Singleton, type HandleOf, type KeyDeclarer } from "./handles.ts";
import { KeyedSlot } from "./keyed-slot.ts";
import { Line } from "./line.ts";
import { Persistence } from "./persistence.ts";
import { Residency } from "./residency.ts";
import { SingletonSlot, type AnyDefinition } from "./slot.ts";
import { Transaction } from "./transaction.ts";

export type DocumentsOwner = {
	readonly label: string;
	readonly batch: Batch;
	readonly context: Context;
	readonly store: { readonly store: ObjectsStore; readonly owner: string } | undefined;
	fail(error: ObjectsError): void;
};
export class Documents {
	readonly label: string;
	readonly batch: Batch;
	readonly context: Context;
	readonly line = new Line();
	readonly own = new SealToken();
	readonly residency = new Residency((sweep) => {
		void this.onLine(async () => sweep()).catch(() => {});
	});
	readonly #owner: DocumentsOwner;
	readonly #slots = new Map<string, SingletonSlot | KeyedSlot>();
	#phase: "open" | "sealed" | "ended" = "open";
	#active: Transaction | undefined;
	#pins: readonly (() => void)[] = [];
	constructor(owner: DocumentsOwner) {
		this.#owner = owner;
		this.label = owner.label;
		this.batch = owner.batch;
		this.context = owner.context;
	}
	declare<D extends StateDefinition<JsonObject, boolean, boolean>>(
		definition: D,
		token: SealToken,
		declarer: KeyDeclarer,
	): HandleOf<D>;
	declare(definition: AnyDefinition, token: SealToken, declarer: KeyDeclarer): Keyed | Singleton {
		let slot = this.#slots.get(definition.name);
		if (slot) slot.definition.check(definition);
		else {
			const owner = definition.persist ? this.#owner.store! : undefined;
			const disk = definition.persist
				? new Persistence(owner!.store, owner!.owner, "objects", definition.name)
				: undefined;
			slot = definition.keyed ? new KeyedSlot(this, definition, disk) : new SingletonSlot(this, definition, disk);
			this.#slots.set(definition.name, slot);
		}
		return slot instanceof KeyedSlot
			? new Keyed(slot, token, definition.version, declarer)
			: new Singleton(slot, token, definition.version);
	}
	hydrate(declared: ReadonlyMap<string, AnyDefinition>, pins: readonly (() => void)[], context: Context): void {
		const previous = this.#pins;
		this.#pins = pins;
		for (const release of previous) release();
		for (const [name, slot] of this.#slots)
			if (!declared.has(name)) {
				this.#slots.delete(name);
				slot.drop();
			}
		for (const [name, definition] of declared) this.#slots.get(name)!.hydrate(definition, context);
	}
	check(definition: AnyDefinition): void {
		this.#slots.get(definition.name)?.definition.check(definition);
	}
	load(context: Context): Promise<void> | undefined {
		const slots = [...this.#slots.values()].filter((slot) => slot.persisted !== undefined);
		if (!slots.length) return undefined;
		return this.onLine(async () => {
			for (const slot of slots) await slot.loadDeclared(context);
		});
	}
	async onLine<T>(job: () => Promise<T>, token?: SealToken): Promise<T> {
		if (this.#phase !== "open" || token?.sealed) throw this.released();
		const release = await this.line.acquire();
		try {
			if (this.#phase !== "open" || token?.sealed) throw this.released();
			return await job();
		} finally {
			release();
		}
	}
	async tx<R>(
		fn: (tx: Transaction) => R | Promise<R>,
		token: SealToken,
		context: Context,
		persistence?: CommitPersistence,
	): Promise<R> {
		this.batch.assertOutside("tx");
		this.assertAdmitted(token);
		const release = await this.line.acquire(),
			transaction = new Transaction(this, token, release, context, persistence);
		try {
			this.assertAdmitted(token);
			this.#active = transaction;
			const result = await fn(transaction),
				commit = transaction.commit();
			if (commit) await commit;
			return result;
		} catch (error) {
			transaction.discard();
			throw error;
		} finally {
			if (this.#active === transaction) this.#active = undefined;
			release();
			transaction.settle();
		}
	}
	fence(token: SealToken): void {
		token.seal();
		if (this.#active?.token === token) this.#cut();
	}
	assertLive(): void {
		if (this.#phase === "ended") throw this.released();
	}
	assertAdmitted(token: SealToken): void {
		if (this.#phase !== "open" || token.sealed) throw this.released();
	}
	fail(error: ObjectsError): void {
		this.#owner.fail(error);
	}
	seal(): void {
		if (this.#phase === "open") {
			this.#phase = "sealed";
			this.own.seal();
			this.#cut();
		}
	}
	async settled(): Promise<void> {
		(await this.line.acquire())();
	}
	end(): void {
		this.#phase = "ended";
		this.residency.end();
		for (const slot of this.#slots.values()) slot.drop();
		this.#slots.clear();
		this.#pins = [];
	}
	released(): ObjectsError {
		return new ObjectsError({
			code: "released",
			reason: "ended",
			message: `${this.label}: ended`,
		});
	}
	#cut(): void {
		const active = this.#active;
		this.#active = undefined;
		active?.cut();
	}
}
