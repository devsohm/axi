export class LruMap<Key, Value> extends Map<Key, Value> {
	readonly #capacity: number;
	constructor(capacity: number) {
		super();
		this.#capacity = capacity;
	}
	override get(key: Key): Value | undefined {
		const value = super.get(key);
		if (value !== undefined) {
			super.delete(key);
			super.set(key, value);
		}
		return value;
	}
	peek(key: Key): Value | undefined {
		return super.get(key);
	}
	override set(key: Key, value: Value): this {
		super.delete(key);
		super.set(key, value);
		if (this.size > this.#capacity) super.delete(this.keys().next().value!);
		return this;
	}
}

export function freezeRecord<Value>(value: Value): Value {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freezeRecord(child);
		Object.freeze(value);
	}
	return value;
}
