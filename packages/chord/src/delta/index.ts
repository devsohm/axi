import type { JsonValue } from "../json.ts";

export type { JsonValue } from "../json.ts";
export type { Draft } from "./draft.ts";
export { diffRevisions } from "./diff.ts";
export { type Change, type Prepared, type Tracker, track } from "./tracker.ts";

export type Seg = string | number;
export type Path = readonly Seg[];
export type NonEmptyPath = readonly [Seg, ...Seg[]];
export type PathRef<P extends Path = Path> = P | number;
export type Op =
	| readonly ["r", JsonValue]
	| readonly ["s", NonEmptyPath, JsonValue]
	| readonly ["d", NonEmptyPath]
	| readonly ["a", NonEmptyPath, string]
	| readonly ["t", NonEmptyPath, number]
	| readonly ["p", Path, number, number, JsonValue[]]
	| readonly ["m", Path, number[]];
export type WireOp =
	| readonly ["r", JsonValue]
	| readonly ["s", PathRef<NonEmptyPath>, JsonValue]
	| readonly ["s", JsonValue]
	| readonly ["d", PathRef<NonEmptyPath>]
	| readonly ["d"]
	| readonly ["a", PathRef<NonEmptyPath>, string]
	| readonly ["a", string]
	| readonly ["t", PathRef<NonEmptyPath>, number]
	| readonly ["t", number]
	| readonly ["p", PathRef, number, number, JsonValue[]]
	| readonly ["p", number, number, JsonValue[]]
	| readonly ["m", PathRef, number[]]
	| readonly ["m", number[]]
	| readonly ["#", number, Path];

export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
export class UnsafePathError extends Error {
	readonly segment: Seg;
	constructor(segment: Seg) {
		super(`unsafe path segment: ${String(segment)}`);
		this.segment = segment;
		this.name = "UnsafePathError";
	}
}
export class PathError extends Error {
	readonly path: Path | number;
	constructor(path: Path | number) {
		super(`unresolvable path: ${JSON.stringify(path)}`);
		this.path = path;
		this.name = "PathError";
	}
}

export const isReplace = (op: Op | WireOp): boolean => op[0] === "r";
export const isBase = (ops: readonly (Op | WireOp)[]): boolean => ops.length > 0 && ops[0][0] === "r";

export function overlap(a: string, b: string, scan: number, probe = 64, maxCandidates = 8): number {
	if (!a.length || !b.length || scan === 0) return 0;
	const suffix = a.length > scan ? a.slice(a.length - scan) : a;
	for (const width of [Math.min(probe, b.length), 1]) {
		const head = b.slice(0, width);
		let attempt = 0;
		for (let position = suffix.indexOf(head); position !== -1; position = suffix.indexOf(head, position + 1)) {
			if (++attempt > maxCandidates) break;
			const length = suffix.length - position;
			if (length <= b.length && suffix.slice(position) === b.slice(0, length)) return length;
		}
		if (width === 1) break;
	}
	return 0;
}

export function assertSafePath(path: Path): void {
	for (const segment of path) {
		if (typeof segment === "string" ? RESERVED_SEGMENTS.has(segment) : !Number.isInteger(segment) || segment < 0) {
			throw new UnsafePathError(segment);
		}
	}
}

function pathArgument(value: unknown, nonEmpty = false): asserts value is Path {
	if (!Array.isArray(value)) throw new TypeError("path is not an array");
	if (nonEmpty && !value.length) throw new TypeError("path is empty");
	assertSafePath(value);
}

function natural(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function permutation(value: unknown): void {
	if (!Array.isArray(value)) throw new TypeError("m permutation is not an array");
	const used = new Uint8Array(value.length);
	for (const index of value) {
		if (!natural(index) || index >= value.length || used[index] !== 0)
			throw new TypeError("m permutation is not a bijection");
		used[index] = 1;
	}
}

export function assertValidOp(value: unknown): asserts value is Op {
	if (!Array.isArray(value) || !value.length) throw new TypeError("op is not a tuple");
	switch (value[0]) {
		case "r":
			if (value.length !== 2) throw new TypeError("r arity");
			return;
		case "s":
			if (value.length !== 3) throw new TypeError("s arity");
			pathArgument(value[1], true);
			return;
		case "d":
			if (value.length !== 2) throw new TypeError("d arity");
			pathArgument(value[1], true);
			return;
		case "a":
			if (value.length !== 3 || typeof value[2] !== "string") throw new TypeError("a shape");
			pathArgument(value[1], true);
			return;
		case "t":
			if (value.length !== 3 || !Number.isInteger(value[2]) || value[2] < 0) throw new TypeError("t shape");
			pathArgument(value[1], true);
			return;
		case "p":
			if (value.length !== 5) throw new TypeError("p arity");
			pathArgument(value[1]);
			if (!Number.isInteger(value[2]) || value[2] < 0) throw new TypeError("p index");
			if (!Number.isInteger(value[3]) || value[3] < 0) throw new TypeError("p remove");
			if (!Array.isArray(value[4])) throw new TypeError("p items");
			return;
		case "m":
			if (value.length !== 3) throw new TypeError("m arity");
			pathArgument(value[1]);
			permutation(value[2]);
			return;
		default:
			throw new TypeError(`unknown op verb: ${String(value[0])}`);
	}
}

export function assertValidWireOp(value: unknown): asserts value is WireOp {
	if (!Array.isArray(value) || !value.length) throw new TypeError("op is not a tuple");
	const [verb] = value;
	const checkRef = (path: unknown): void => {
		if (typeof path === "number") {
			if (!natural(path)) throw new TypeError("bad path id");
		} else pathArgument(path);
	};
	switch (verb) {
		case "r":
			if (value.length !== 2) throw new TypeError("r arity");
			return;
		case "s":
			if (value.length === 3) checkRef(value[1]);
			else if (value.length !== 2) throw new TypeError("s arity");
			return;
		case "d":
			if (value.length === 2) checkRef(value[1]);
			else if (value.length !== 1) throw new TypeError("d arity");
			return;
		case "a":
			if (value.length === 3) {
				checkRef(value[1]);
				if (typeof value[2] !== "string") throw new TypeError("a value");
			} else if (value.length === 2) {
				if (typeof value[1] !== "string") throw new TypeError("a value");
			} else throw new TypeError("a arity");
			return;
		case "t":
			if (value.length === 3) {
				checkRef(value[1]);
				if (!Number.isInteger(value[2]) || value[2] < 0) throw new TypeError("t count");
			} else if (value.length === 2) {
				if (!Number.isInteger(value[1]) || value[1] < 0) throw new TypeError("t count");
			} else throw new TypeError("t arity");
			return;
		case "p": {
			const [index, remove, items] =
				value.length === 5 ? [value[2], value[3], value[4]] : value.length === 4 ? [value[1], value[2], value[3]] : [];
			if (items === undefined) throw new TypeError("p arity");
			if (value.length === 5) checkRef(value[1]);
			if (!natural(index)) throw new TypeError("p index");
			if (!natural(remove)) throw new TypeError("p remove");
			if (!Array.isArray(items)) throw new TypeError("p items");
			return;
		}
		case "m":
			if (value.length === 3) checkRef(value[1]);
			else if (value.length !== 2) throw new TypeError("m arity");
			permutation(value[value.length - 1]);
			return;
		case "#":
			if (value.length !== 3 || !Number.isInteger(value[1]) || value[1] < 0 || !Array.isArray(value[2]))
				throw new TypeError("# shape");
			assertSafePath(value[2]);
			return;
		default:
			throw new TypeError(`unknown op verb: ${String(verb)}`);
	}
}

type Container = JsonValue[] | Record<string, JsonValue>;
const container = (value: unknown): value is Container => value !== null && typeof value === "object";
const read = (value: Container, key: Seg): JsonValue => (value as Record<Seg, JsonValue>)[key];
const put = (value: Container, key: Seg, data: JsonValue): void => {
	Object.defineProperty(value, key, { value: data, writable: true, enumerable: true, configurable: true });
};

function resolve(root: JsonValue, path: Path): Container {
	let target = root;
	for (const segment of path) {
		if (!container(target)) throw new PathError(path);
		if (Array.isArray(target) && typeof segment !== "number") throw new UnsafePathError(segment);
		if (!Object.hasOwn(target, segment)) throw new PathError(path);
		target = read(target, segment);
	}
	if (!container(target)) throw new PathError(path);
	return target;
}

function mutable<T>(target: T | undefined, operations: readonly Op[]): T {
	let root = target as JsonValue;
	for (const operation of operations) {
		assertValidOp(operation);
		if (operation[0] === "r") {
			root = operation[1];
			continue;
		}
		const path = operation[1];
		assertSafePath(path);
		if (operation[0] === "p" || operation[0] === "m") {
			const array = path.length ? resolve(root, path) : root;
			if (!Array.isArray(array)) throw new PathError(path);
			if (operation[0] === "p") {
				array.splice(operation[2], operation[3]);
				for (let at = 0; at < operation[4].length; at += 10_000) {
					array.splice(operation[2] + at, 0, ...operation[4].slice(at, at + 10_000));
				}
			} else {
				if (array.length !== operation[2].length) throw new PathError(path);
				const previous = array.slice();
				for (let i = 0; i < operation[2].length; i++) array[i] = previous[operation[2][i]];
			}
			continue;
		}
		const parent = resolve(root, path.slice(0, -1));
		const key = path[path.length - 1];
		if (Array.isArray(parent) && (typeof key !== "number" || key > parent.length)) throw new UnsafePathError(key);
		const write = (value: JsonValue): void => put(parent, key, value);
		const current = (): JsonValue | undefined => (Object.hasOwn(parent, key) ? read(parent, key) : undefined);
		switch (operation[0]) {
			case "s":
				write(operation[2]);
				break;
			case "d":
				if (Array.isArray(parent)) {
					if (typeof key !== "number" || key >= parent.length) throw new PathError(path);
					parent.splice(key, 1);
				} else delete parent[key];
				break;
			case "a": {
				const value = current();
				if (typeof value !== "string") throw new PathError(path);
				write(value + operation[2]);
				break;
			}
			case "t": {
				const value = current();
				if (typeof value !== "string") throw new PathError(path);
				write(value.slice(operation[2]));
				break;
			}
		}
	}
	return root as T;
}

export function apply<T>(target: T | undefined, ops: readonly Op[]): T {
	return mutable(target, ops);
}
export function applyImmutable<T>(target: T | undefined, ops: readonly Op[]): T {
	return applyImmutableBatches(target, [ops]);
}
export function applyImmutableBatches<T>(target: T | undefined, batches: Iterable<readonly Op[]>): T {
	let root = target as JsonValue;
	const owned = new WeakSet<object>();
	for (const operations of batches) {
		for (const operation of operations) {
			assertValidOp(operation);
			if (operation[0] === "r") {
				root = operation[1];
				continue;
			}
			if (operation[0] === "p") {
				const appended = append(root, operation, owned);
				if (appended !== undefined) {
					root = appended;
					continue;
				}
			}
			const path = operation[0] === "p" || operation[0] === "m" ? operation[1] : operation[1].slice(0, -1);
			root = copyPath(root, path, owned);
			root = mutable(root, [operation]);
		}
	}
	return root as T;
}

function append(root: JsonValue, operation: Extract<Op, { 0: "p" }>, owned: WeakSet<object>): JsonValue | undefined {
	const [, path, index, remove, items] = operation;
	if (remove !== 0) return undefined;
	let target = root;
	for (const key of path) {
		const valid =
			typeof key === "string"
				? !RESERVED_SEGMENTS.has(key) && container(target) && !Array.isArray(target)
				: Number.isInteger(key) && key >= 0 && Array.isArray(target);
		if (!valid || !Object.hasOwn(target as object, key)) return undefined;
		target = read(target as Container, key);
	}
	if (!Array.isArray(target) || owned.has(target) || index !== target.length) return undefined;
	const next = target.concat(items);
	owned.add(next);
	if (!path.length) return next;
	const parent = path.slice(0, -1);
	const copied = copyPath(root, parent, owned);
	put(resolve(copied, parent), path[path.length - 1], next);
	return copied;
}

function copyPath(root: JsonValue, path: Path, owned: WeakSet<object>): JsonValue {
	const copy = (value: JsonValue): Container => {
		if (Array.isArray(value)) return value.slice();
		if (!container(value)) throw new PathError(path);
		const result: Record<string, JsonValue> = Object.create(
			Object.getPrototypeOf(value) === null ? null : Object.prototype,
		);
		for (const key of Object.keys(value)) put(result, key, value[key]);
		return result;
	};
	if (!container(root)) throw new PathError(path);
	let result = root;
	if (!owned.has(root)) {
		result = copy(root);
		owned.add(result);
	}
	let target = result;
	for (const key of path) {
		if (!Object.hasOwn(target, key)) throw new PathError(path);
		if (Array.isArray(target) && typeof key !== "number") throw new UnsafePathError(key);
		const child = read(target, key);
		if (!container(child)) throw new PathError(path);
		if (owned.has(child)) {
			target = child;
			continue;
		}
		const next = copy(child);
		put(target, key, next);
		owned.add(next);
		target = next;
	}
	return result;
}

export interface Encoder {
	encode(ops: readonly Op[]): WireOp[];
}
export function encoder(): Encoder {
	const seen = new Set<string>();
	const dictionary = new Map<string, number>();
	let next = 0;
	return {
		encode(ops) {
			const result: WireOp[] = [];
			let previous: string | undefined;
			for (const op of ops) {
				if (op[0] === "r") {
					result.push(op);
					seen.clear();
					dictionary.clear();
					next = 0;
					previous = undefined;
					continue;
				}
				const key = JSON.stringify(op[1]);
				let ref: PathRef = op[1];
				if (key !== previous) {
					const entry = dictionary.get(key);
					if (entry !== undefined) ref = entry;
					else if (seen.has(key)) {
						ref = next++;
						dictionary.set(key, ref);
						result.push(["#", ref, op[1]]);
					} else seen.add(key);
				}
				const short = key === previous;
				const leaf = ref as PathRef<NonEmptyPath>;
				switch (op[0]) {
					case "s":
						result.push(short ? ["s", op[2]] : ["s", leaf, op[2]]);
						break;
					case "d":
						result.push(short ? ["d"] : ["d", leaf]);
						break;
					case "a":
						result.push(short ? ["a", op[2]] : ["a", leaf, op[2]]);
						break;
					case "t":
						result.push(short ? ["t", op[2]] : ["t", leaf, op[2]]);
						break;
					case "p":
						result.push(short ? ["p", op[2], op[3], op[4]] : ["p", ref, op[2], op[3], op[4]]);
						break;
					case "m":
						result.push(short ? ["m", op[2]] : ["m", ref, op[2]]);
						break;
				}
				previous = key;
			}
			return result;
		},
	};
}

export interface Decoder {
	decode(wire: readonly unknown[]): Op[];
}
export function decoder(): Decoder {
	const dictionary = new Map<number, Path>();
	return {
		decode(wire) {
			const result: Op[] = [];
			let previous: Path | undefined;
			for (const entry of wire) {
				assertValidWireOp(entry);
				if (entry[0] === "#") {
					assertSafePath(entry[2]);
					dictionary.set(entry[1], entry[2]);
					continue;
				}
				if (entry[0] === "r") {
					result.push(entry);
					dictionary.clear();
					previous = undefined;
					continue;
				}
				const fullLength = entry[0] === "p" ? 5 : entry[0] === "d" ? 2 : 3;
				const short = entry.length < fullLength;
				let path = previous;
				if (!short) {
					const ref = entry[1] as PathRef;
					path = typeof ref === "number" ? dictionary.get(ref) : ref;
					if (!path) throw new PathError(ref);
				}
				if (!path || (!path.length && entry[0] !== "p" && entry[0] !== "m")) throw new PathError(path ?? []);
				if (!short) previous = path;
				const leaf = path as NonEmptyPath;
				switch (entry[0]) {
					case "s":
						result.push(["s", leaf, (short ? entry[1] : entry[2]) as JsonValue]);
						break;
					case "d":
						result.push(["d", leaf]);
						break;
					case "a":
						result.push(["a", leaf, (short ? entry[1] : entry[2]) as string]);
						break;
					case "t":
						result.push(["t", leaf, (short ? entry[1] : entry[2]) as number]);
						break;
					case "p": {
						const [index, remove, items] = short
							? [entry[1] as number, entry[2] as number, entry[3] as JsonValue[]]
							: [entry[2] as number, entry[3] as number, entry[4] as JsonValue[]];
						result.push(["p", path, index, remove, items]);
						break;
					}
					case "m":
						result.push(["m", path, (short ? entry[1] : entry[2]) as number[]]);
						break;
				}
			}
			return result;
		},
	};
}
