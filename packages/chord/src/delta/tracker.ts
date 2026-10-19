import { copyJson, type JsonValue } from "../json.ts";
import type { Draft } from "./draft.ts";
import { applyImmutableTrusted } from "./apply-immutable-trusted.ts";
import { ArrayLayout, type InsertSource, type Span, type StoredRef } from "./array-layout.ts";
import { equalJson } from "./diff.ts";
import {
	applyImmutable,
	type NonEmptyPath,
	type Op,
	overlap,
	type Path,
	RESERVED_SEGMENTS,
	type Seg,
} from "./index.ts";

export type { Draft, JsonValue, Op };
export interface Prepared<T extends object> {
	readonly base: T;
	readonly value: T;
	readonly ops: readonly Op[];
	readonly baseRevision: number;
	abort(): void;
}
export interface Change<T extends object> {
	readonly state: Draft<T>;
	prepare(): Prepared<T>;
	abort(): void;
}
export interface Tracker<T extends object> {
	readonly value: T;
	readonly revision: number;
	beginChange(): Change<T>;
	prepareReplace(value: T): Prepared<T>;
	adopt(prepared: Prepared<T>): void;
}

type Container = JsonValue[] | Record<string, JsonValue>;
type Status = "open" | "prepared" | "consumed" | "aborted" | "stale";
type Node = {
	scope: Scope;
	index: number;
	target: Container;
	proxy: Container;
	parentIndex: number;
	parentKind: 0 | 1 | 2;
	parentKey: string | number;
	parentSource?: InsertSource;
	placement: boolean;
	writeKey?: string;
	writeValue?: StoredRef;
	writes?: Map<string, StoredRef>;
	deleteKey?: string;
	deleted?: Set<string>;
	readded?: Set<string>;
	slots?: ArrayLayout;
	changed?: boolean;
	dirty?: boolean;
	preparedPath?: Path;
};
type StatusCell = { value: Status };
type Scope = {
	owner: object;
	tracker: WeakRef<RevisionTracker<object>>;
	revision: number;
	status: StatusCell;
	root: Node | undefined;
	bases: Container[] | undefined;
	stored: Container[] | undefined;
	nodes: Node[];
	raw: WeakMap<object, Node> | undefined;
	dirty: Node[];
	simple: boolean;
	ops: Op[] | undefined;
	replacement: boolean;
	replacementNoop: boolean;
	baseValue: object | undefined;
	released: boolean;
	registryRef: WeakRef<Scope> | undefined;
};
const OVERLAY = Symbol("axi.delta.overlay.node");
const preparations = new WeakMap<object, Scope>();
const arrayMethods = new Set(["push", "pop", "shift", "unshift", "splice", "reverse", "sort", "fill", "copyWithin"]);
const isContainer = (value: unknown): value is Container => value !== null && typeof value === "object";
const get = (value: Container, key: Seg): JsonValue => Reflect.get(value, key);
const descriptor: PropertyDescriptor = { value: undefined, configurable: true, writable: true, enumerable: true };
const put = (value: Container, key: Seg, item: JsonValue): void => {
	descriptor.value = item;
	Object.defineProperty(value, key, descriptor);
	descriptor.value = undefined;
};
function childPath(path: Path, key: Seg): NonEmptyPath {
	const result: [Seg, ...Seg[]] = [key];
	for (let index = 0; index < path.length; index++) result[index] = path[index];
	result[path.length] = key;
	return result;
}
const nodeBase = (node: Node): Container => node.scope.bases![node.index];
const parentOf = (node: Node): Node | undefined =>
	node.parentIndex < 0 ? undefined : node.scope.nodes[node.parentIndex];
const released: Record<string, JsonValue> = {};
function store(scope: Scope, value: JsonValue, previous?: StoredRef): StoredRef {
	if (typeof previous === "object" && previous !== null) {
		scope.stored![previous.index] = isContainer(value) ? value : released;
		return isContainer(value) ? previous : value;
	}
	if (!isContainer(value)) return value;
	const index = scope.stored!.length;
	scope.stored!.push(value);
	return { index };
}
function unstore(scope: Scope, value: StoredRef): JsonValue {
	return typeof value === "object" && value !== null ? scope.stored![value.index] : value;
}
function releaseStored(scope: Scope, value: StoredRef | undefined): void {
	if (typeof value === "object" && value !== null) scope.stored![value.index] = released;
}

function close(scope: Scope, dropOnly = false): void {
	scope.tracker.deref()?.releaseContext(scope);
	if (locatedArray?.scope === scope) locatedArray = undefined;
	if (!dropOnly)
		for (const node of scope.nodes) {
			if (Array.isArray(node.target)) node.target.length = 0;
			Reflect.deleteProperty(node.target, OVERLAY);
			node.writes?.clear();
			node.deleted?.clear();
			node.readded?.clear();
			node.slots?.clear();
			node.target = released;
			node.proxy = released;
			node.writeKey = undefined;
			node.writeValue = undefined;
			node.writes = undefined;
			node.deleteKey = undefined;
			node.deleted = undefined;
			node.readded = undefined;
			node.slots = undefined;
			node.parentSource = undefined;
			node.changed = undefined;
			node.preparedPath = undefined;
		}
	scope.dirty.length = 0;
	scope.nodes.length = 0;
	scope.raw = undefined;
	scope.ops = undefined;
	scope.root = undefined;
	scope.bases = undefined;
	scope.stored = undefined;
	scope.baseValue = undefined;
	scope.released = true;
}
function abort(scope: Scope): void {
	if (scope.status.value === "consumed" || scope.status.value === "stale" || scope.status.value === "aborted") return;
	scope.status.value = "aborted";
	close(scope);
}
function settled(scope: Scope): boolean {
	return (
		scope.released ||
		scope.status.value === "consumed" ||
		scope.status.value === "aborted" ||
		scope.status.value === "stale"
	);
}
function load(node: Node | undefined): Node {
	if (!node || settled(node.scope)) throw new TypeError("Cannot use a settled overlay");
	return node;
}
function writable(node: Node | undefined): Node {
	const current = load(node);
	if (current.scope.status.value !== "open") throw new TypeError("Prepared overlays are read-only");
	return current;
}
const targetNode = (target: object): Node | undefined => Reflect.get(target, OVERLAY) as Node | undefined;
function indexKey(key: PropertyKey): number | undefined {
	if (typeof key !== "string" || key.length === 0 || key.length > 10) return undefined;
	if (key === "0") return 0;
	if (key.charCodeAt(0) < 49 || key.charCodeAt(0) > 57) return undefined;
	let index = 0;
	for (let offset = 0; offset < key.length; offset++) {
		const digit = key.charCodeAt(offset) - 48;
		if (digit < 0 || digit > 9) return undefined;
		index = index * 10 + digit;
		if (index >= 4_294_967_295) return undefined;
	}
	return index;
}
function hasWrite(node: Node, key: string): boolean {
	return node.writeKey === key || (node.writes?.has(key) ?? false);
}
function written(node: Node, key: string): JsonValue {
	return unstore(node.scope, node.writeKey === key ? node.writeValue! : node.writes!.get(key)!);
}
function write(node: Node, key: string, value: JsonValue): void {
	if (node.writes) node.writes.set(key, store(node.scope, value, node.writes.get(key)));
	else if (typeof key === "string" && (node.writeKey === undefined || node.writeKey === key)) {
		node.writeKey = key;
		node.writeValue = store(node.scope, value, node.writeValue);
	} else {
		node.writes = new Map();
		if (node.writeKey !== undefined) node.writes.set(node.writeKey, node.writeValue!);
		node.writes.set(key, store(node.scope, value));
		node.writeKey = undefined;
		node.writeValue = undefined;
	}
}
function removeWrite(node: Node, key: string): void {
	if (node.writeKey === key) {
		releaseStored(node.scope, node.writeValue);
		node.writeKey = undefined;
		node.writeValue = undefined;
	} else {
		releaseStored(node.scope, node.writes?.get(key));
		node.writes?.delete(key);
	}
}
function hasDeletion(node: Node, key: string): boolean {
	return node.deleteKey === key || (node.deleted?.has(key) ?? false);
}
function removeDeletion(node: Node, key: string): void {
	if (node.deleteKey === key) node.deleteKey = undefined;
	else node.deleted?.delete(key);
}
function deleteKey(node: Node, key: string): void {
	if (node.deleted) node.deleted.add(key);
	else if (node.deleteKey === undefined || node.deleteKey === key) node.deleteKey = key;
	else {
		node.deleted = new Set([node.deleteKey, key]);
		node.deleteKey = undefined;
	}
}
function reservedMutation(node: Node): boolean {
	if (node.writeKey !== undefined && RESERVED_SEGMENTS.has(node.writeKey)) return true;
	if (node.deleteKey !== undefined && RESERVED_SEGMENTS.has(node.deleteKey)) return true;
	if (node.writes)
		for (const key of node.writes.keys()) if (typeof key === "string" && RESERVED_SEGMENTS.has(key)) return true;
	if (node.deleted) for (const key of node.deleted) if (RESERVED_SEGMENTS.has(key)) return true;
	return false;
}
function entryValue(node: Node, index: number, source?: InsertSource): JsonValue {
	const overrides = source ? node.slots?.insertWrites?.get(source) : node.slots?.baseWrites;
	const value = overrides?.get(index);
	return value !== undefined
		? unstore(node.scope, value)
		: source
			? unstore(node.scope, source.refs[index])
			: (nodeBase(node) as JsonValue[])[index];
}
function rawAt(node: Node, index: number): JsonValue {
	if (!node.slots) return (nodeBase(node) as JsonValue[])[index];
	const span = node.slots.locate(index);
	return entryValue(node, span.start + span.step * node.slots.offset, span.kind === "insert" ? span.source : undefined);
}
function writeEntry(node: Node, index: number, value: JsonValue, source?: InsertSource): void {
	const list = slots(node);
	let overrides = source ? list.insertWrites?.get(source) : list.baseWrites;
	const previous = overrides?.get(index);
	const original = source ? unstore(node.scope, source.refs[index]) : (nodeBase(node) as JsonValue[])[index];
	if (!isContainer(value) && value === original) {
		releaseStored(node.scope, previous);
		overrides?.delete(index);
		if (source && overrides?.size === 0) list.insertWrites?.delete(source);
	} else {
		if (!overrides) {
			overrides = new Map();
			if (source) (list.insertWrites ??= new Map()).set(source, overrides);
			else list.baseWrites = overrides;
		}
		overrides.set(index, store(node.scope, value, previous));
	}
}
function objectHas(node: Node, key: string): boolean {
	return !hasDeletion(node, key) && (hasWrite(node, key) || Object.hasOwn(nodeBase(node), key));
}
function objectValue(node: Node, key: string): JsonValue {
	return hasWrite(node, key) ? written(node, key) : get(nodeBase(node), key);
}
function mark(scope: Scope, node: Node): void {
	if (node.dirty) return;
	node.dirty = true;
	scope.dirty.push(node);
	for (let current = parentOf(node); current; current = parentOf(current)) current.changed = true;
}
function slots(node: Node): ArrayLayout {
	return (node.slots ??= new ArrayLayout((nodeBase(node) as JsonValue[]).length));
}
function keys(node: Node): string[] {
	if (Array.isArray(nodeBase(node))) {
		const size = slots(node).length,
			result = new Array<string>(size + 1);
		for (let index = 0; index < size; index++) result[index] = String(index);
		result[size] = "length";
		return result;
	}
	let existingOnly =
		node.deleteKey === undefined &&
		node.deleted === undefined &&
		node.readded === undefined &&
		(node.writeKey === undefined || Object.hasOwn(nodeBase(node), node.writeKey));
	if (existingOnly && node.writes)
		for (const key of node.writes.keys())
			if (!Object.hasOwn(nodeBase(node), key)) {
				existingOnly = false;
				break;
			}
	if (existingOnly) return Object.keys(nodeBase(node));
	const result = Object.keys(nodeBase(node)).filter((key) => !hasDeletion(node, key) && !node.readded?.has(key));
	const seen = new Set(result);
	if (node.writeKey !== undefined && !seen.has(node.writeKey)) {
		result.push(node.writeKey);
		seen.add(node.writeKey);
	}
	if (node.writes)
		for (const key of node.writes.keys()) {
			if (!seen.has(key)) {
				result.push(key);
				seen.add(key);
			}
		}
	const indices: number[] = [],
		names: string[] = [];
	for (const key of result) {
		const index = indexKey(key);
		if (index === undefined) names.push(key);
		else indices.push(index);
	}
	indices.sort((a, b) => a - b);
	return [...indices.map(String), ...names];
}
function publicValue(
	scope: Scope,
	parent: Node,
	key: string | number,
	value: JsonValue,
	source?: InsertSource,
): JsonValue {
	return isContainer(value) ? nodeFor(scope, value, parent, key, source).proxy : value;
}
function at(scope: Scope, node: Node, index: number): JsonValue | undefined {
	const list = slots(node);
	if (index >= list.length) return undefined;
	const span = list.locate(index),
		key = span.start + span.step * list.offset;
	const source = span.kind === "insert" ? span.source : undefined;
	return publicValue(scope, node, key, entryValue(node, key, source), source);
}
function property(current: Node | undefined, key: PropertyKey): unknown {
	if (key === "then" && (!current || settled(current.scope))) return undefined;
	const node = load(current),
		scope = node.scope;
	if (key === OVERLAY) return node;
	if (Array.isArray(nodeBase(node))) {
		const list = slots(node);
		if (key === "length") return list.length;
		if (typeof key === "string" && arrayMethods.has(key)) return mutators[key];
		const index = indexKey(key);
		return index !== undefined ? at(scope, node, index) : Reflect.get(Array.prototype, key, node.proxy);
	}
	if (typeof key === "symbol") return Reflect.get(nodeBase(node), key, node.proxy);
	const name = String(key);
	if (objectHas(node, name)) return publicValue(scope, node, name, objectValue(node, name));
	return hasDeletion(node, name) || Object.hasOwn(nodeBase(node), key)
		? undefined
		: Reflect.get(nodeBase(node), key, node.proxy);
}
const handler: ProxyHandler<Container> = {
	get(target, key) {
		return property(targetNode(target), key);
	},
	set(target, key, supplied) {
		const node = writable(targetNode(target)),
			scope = node.scope;
		if (typeof key === "symbol") throw new TypeError("Symbol writes are not supported");
		if (Array.isArray(nodeBase(node))) {
			if (key === "length") {
				const next = Number(supplied);
				if (!Number.isInteger(next) || next < 0 || next >= 4_294_967_296) throw new RangeError("Invalid array length");
				const list = slots(node);
				if (next !== list.length) {
					list.length = next;
					mark(scope, node);
				}
				return true;
			}
			const index = indexKey(key);
			if (index === undefined) throw new TypeError("Only array indices and length can be written");
			const list = slots(node);
			if (index > list.length) throw new TypeError("Overlay arrays cannot contain holes");
			const value = placement(supplied);
			if (index === list.length) list.insert(index, 0, [store(scope, value)]);
			else {
				const span = list.locate(index),
					key = span.start + span.step * list.offset;
				const source = span.kind === "insert" ? span.source : undefined;
				if (!isContainer(value) && entryValue(node, key, source) === value) return true;
				writeEntry(node, key, value, source);
			}
		} else {
			if (supplied === undefined) return handler.deleteProperty!(target, key);
			const value = placement(supplied);
			if (!hasDeletion(node, key) && !isContainer(value) && objectValue(node, key) === value) return true;
			if (hasDeletion(node, key) && Object.hasOwn(nodeBase(node), key)) (node.readded ??= new Set()).add(key);
			removeDeletion(node, key);
			write(node, key, value);
		}
		mark(scope, node);
		return true;
	},
	deleteProperty(target, key) {
		const node = writable(targetNode(target));
		if (typeof key === "symbol") throw new TypeError("Symbol writes are not supported");
		if (Array.isArray(nodeBase(node))) throw new TypeError("Overlay arrays cannot contain holes");
		if (objectHas(node, key)) {
			removeWrite(node, key);
			node.readded?.delete(key);
			deleteKey(node, key);
			mark(node.scope, node);
		}
		return true;
	},
	ownKeys(target) {
		return keys(load(targetNode(target)));
	},
	getOwnPropertyDescriptor(target, key) {
		const node = load(targetNode(target));
		if (Array.isArray(nodeBase(node))) {
			if (key === "length") {
				target.length = slots(node).length;
				return Reflect.getOwnPropertyDescriptor(target, key);
			}
			const index = indexKey(key);
			if (index === undefined || index >= slots(node).length) return undefined;
		} else if (typeof key === "symbol" || !objectHas(node, key)) return undefined;
		return {
			value: property(node, key),
			configurable: true,
			enumerable: true,
			writable: node.scope.status.value === "open",
		};
	},
	has(target, key) {
		const node = load(targetNode(target));
		if (!Array.isArray(nodeBase(node))) return typeof key === "symbol" ? key in nodeBase(node) : objectHas(node, key);
		const index = indexKey(key);
		return key === "length" || (index === undefined ? key in Array.prototype : index < slots(node).length);
	},
	getPrototypeOf(target) {
		return Object.getPrototypeOf(nodeBase(load(targetNode(target))));
	},
	isExtensible(target) {
		load(targetNode(target));
		return true;
	},
	defineProperty(target) {
		writable(targetNode(target));
		throw new TypeError("Defining overlay properties is not supported");
	},
	setPrototypeOf(target) {
		writable(targetNode(target));
		throw new TypeError("Changing an overlay prototype is not supported");
	},
	preventExtensions(target) {
		writable(targetNode(target));
		throw new TypeError("Overlays cannot be made non-extensible");
	},
};

function nodeFor(scope: Scope, base: Container, parent?: Node, key?: string | number, source?: InsertSource): Node {
	const data = scope,
		existing = data.raw!.get(base);
	if (existing) return existing;
	const target: Container = Array.isArray(base) ? [] : {};
	const node: Node = {
		scope,
		index: data.bases!.length,
		target,
		proxy: target,
		parentIndex: parent?.index ?? -1,
		parentKind: parent === undefined || typeof key === "string" ? 0 : source === undefined ? 1 : 2,
		parentKey: key ?? "",
		placement:
			source !== undefined ||
			(parent !== undefined &&
				key !== undefined &&
				(typeof key === "string" ? hasWrite(parent, key) : (parent.slots?.baseWrites?.has(key) ?? false))),
	};
	if (source !== undefined) node.parentSource = source;
	Reflect.set(target, OVERLAY, node);
	node.proxy = new Proxy(target, handler);
	data.bases!.push(base);
	data.nodes.push(node);
	data.raw!.set(base, node);
	return node;
}
function newScope(
	tracker: WeakRef<RevisionTracker<object>>,
	owner: object,
	revision: number,
	base: Container,
	replacement: boolean,
	baseValue: object,
): Scope {
	const scope: Scope = {
		owner,
		tracker,
		revision,
		status: { value: "open" },
		root: undefined,
		bases: [],
		stored: [],
		dirty: [],
		nodes: [],
		raw: new WeakMap(),
		ops: undefined,
		replacement,
		replacementNoop: false,
		baseValue,
		released: false,
		simple: false,
		registryRef: undefined,
	};
	scope.root = nodeFor(scope, base);
	return scope;
}

function locate(node: Node): Path | undefined {
	if (node.preparedPath) return node.preparedPath;
	const parent = parentOf(node);
	if (!parent) return (node.preparedPath = []);
	const key = node.parentKey!,
		path = locate(parent);
	if (!path) return undefined;
	if (node.parentKind === 0) {
		if (typeof key !== "string" || !objectHas(parent, key) || objectValue(parent, key) !== nodeBase(node))
			return undefined;
		return (node.preparedPath = [...path, key]);
	}
	if (typeof key === "string") return undefined;
	const list = slots(parent);
	const index = list.indexOf(key, node.parentSource);
	if (index < 0 || rawAt(parent, index) !== nodeBase(node)) return undefined;
	return (node.preparedPath = [...path, index]);
}
function placement(value: unknown): JsonValue {
	const node = isContainer(value) ? targetNode(value) : undefined;
	return node ? materialize(load(node).scope, nodeBase(node), true) : copyJson(value);
}
function materialize(scope: Scope, value: JsonValue, detached = false): JsonValue {
	if (!isContainer(value)) return detached ? copyJson(value) : value;
	const node = scope.raw!.get(value);
	if (!node) return detached ? copyJson(value) : value;
	if (!detached && !node.dirty && !node.changed) return value;
	if (Array.isArray(value)) {
		const result: JsonValue[] = [];
		for (const span of slots(node).spans)
			for (let i = 0; i < span.length; i++)
				result.push(
					materialize(
						scope,
						entryValue(node, span.start + span.step * i, span.kind === "insert" ? span.source : undefined),
						detached,
					),
				);
		return result;
	}
	const result: Record<string, JsonValue> = Object.create(Object.getPrototypeOf(value));
	for (const key of keys(node)) put(result, key, materialize(scope, objectValue(node, key), detached));
	return result;
}

function relative(value: unknown, size: number, fallback = 0): number {
	const integer = value === undefined ? fallback : relativeInteger(value);
	return integer < 0 ? Math.max(0, size + integer) : Math.min(size, integer);
}
function relativeInteger(value: unknown): number {
	const n = Number(value);
	return Number.isNaN(n) || n === 0 ? 0 : Number.isFinite(n) ? Math.trunc(n) : n;
}
function mutatorNode(receiver: unknown): Node | undefined {
	const current = isContainer(receiver) ? targetNode(receiver) : undefined;
	if (!current) return undefined;
	if (!Array.isArray(nodeBase(current))) throw new TypeError("Array mutator called on incompatible receiver");
	return writable(current);
}
function placedRefs(node: Node, values: unknown[], start = 0): StoredRef[] {
	if (values.length === start) return values as StoredRef[];
	const scope = node.scope;
	const storedLength = scope.stored!.length;
	try {
		for (let i = start; i < values.length; i++) values[i] = store(scope, placement(values[i]));
	} catch (error) {
		scope.stored!.length = storedLength;
		throw error;
	}
	return values as StoredRef[];
}
function insertRefs(node: Node, start: number, remove: number, values: StoredRef[], offset = 0): void {
	if (!remove && values.length === offset) return;
	slots(node).insert(start, remove, values, offset);
	mark(node.scope, node);
}
function insertValues(node: Node, start: number, remove: number, values: JsonValue[]): void {
	const refs: StoredRef[] = [];
	for (const value of values) refs.push(store(node.scope, value));
	insertRefs(node, start, remove, refs);
}
function appendSpan(spans: Span[], span: Span): void {
	const last = spans.at(-1);
	if (
		last &&
		last.kind === span.kind &&
		(last.kind === "base" || (span.kind === "insert" && last.source === span.source))
	) {
		const distance = span.start - last.start;
		if (last.length === 1 && span.length === 1 && (distance === 1 || distance === -1)) {
			last.step = distance;
			last.length = 2;
			return;
		}
		if (last.step === span.step && last.start + last.step * last.length === span.start) {
			last.length += span.length;
			return;
		}
	}
	spans.push(span);
}
function deduplicate(node: Node): void {
	const list = slots(node),
		base = new Set<number>(),
		inserted = new Map<InsertSource, Set<number>>(),
		spans: Span[] = [];
	let changed = false;
	for (const span of list.spans)
		for (let i = 0; i < span.length; i++) {
			const index = span.start + span.step * i,
				source = span.kind === "insert" ? span.source : undefined;
			let seen = source ? inserted.get(source) : base;
			if (!seen) inserted.set(source!, (seen = new Set()));
			if (seen.has(index)) {
				changed = true;
				const value = materialize(node.scope, entryValue(node, index, source), true);
				appendSpan(spans, {
					kind: "insert",
					source: { refs: [store(node.scope, value)] },
					start: 0,
					length: 1,
					step: 1,
				});
			} else appendSpan(spans, { ...span, start: index, length: 1 });
			seen.add(index);
		}
	if (changed) {
		list.replace(0, list.length, spans);
		mark(node.scope, node);
	}
}
const mutators: Record<string, (this: unknown, ...args: unknown[]) => unknown> = {
	push(this: unknown, ...items: unknown[]) {
		const node = mutatorNode(this);
		if (!node) return Reflect.apply(Array.prototype.push, this, items);
		const size = slots(node).length;
		insertRefs(node, size, 0, placedRefs(node, items));
		return size + items.length;
	},
	pop(this: unknown) {
		const node = mutatorNode(this);
		if (!node) return Reflect.apply(Array.prototype.pop, this, []);
		const size = slots(node).length;
		if (!size) return undefined;
		const value = at(node.scope, node, size - 1);
		insertRefs(node, size - 1, 1, []);
		return value;
	},
	shift(this: unknown) {
		const node = mutatorNode(this);
		if (!node) return Reflect.apply(Array.prototype.shift, this, []);
		const size = slots(node).length;
		if (!size) return undefined;
		const value = at(node.scope, node, 0);
		insertRefs(node, 0, 1, []);
		return value;
	},
	unshift(this: unknown, ...items: unknown[]) {
		const node = mutatorNode(this);
		if (!node) return Reflect.apply(Array.prototype.unshift, this, items);
		insertRefs(node, 0, 0, placedRefs(node, items));
		return slots(node).length;
	},
	splice(this: unknown, ...args: unknown[]) {
		const node = mutatorNode(this);
		if (!node) return Reflect.apply(Array.prototype.splice, this, args);
		const size = slots(node).length;
		const start = args.length ? relative(args[0], size) : 0;
		const remove = !args.length
			? 0
			: args.length === 1
				? size - start
				: Math.min(size - start, Math.max(0, relativeInteger(args[1])));
		const removed = Array.from({ length: remove }, (_, i) => at(node.scope, node, start + i));
		const offset = Math.min(2, args.length);
		const added = Math.max(0, args.length - 2);
		insertRefs(node, start, remove, placedRefs(node, args, offset), offset);
		slots(node).length = size - remove + added;
		return removed;
	},
	reverse(this: unknown) {
		const node = mutatorNode(this);
		if (!node) return Reflect.apply(Array.prototype.reverse, this, []);
		const list = slots(node);
		if (list.length > 1) {
			list.reverse();
			mark(node.scope, node);
		}
		return node.proxy;
	},
	sort(this: unknown, compare?: unknown) {
		const node = mutatorNode(this);
		if (!node) return Reflect.apply(Array.prototype.sort, this, [compare]);
		const scope = node.scope;
		if (compare !== undefined && typeof compare !== "function") throw new TypeError("Comparator must be a function");
		const list = slots(node),
			order: number[] = [],
			sources: InsertSource[] = [],
			indices: number[] = [];
		const baseValues: JsonValue[] = new Array((nodeBase(node) as JsonValue[]).length),
			addedValues: JsonValue[] = [];
		for (const span of list.spans)
			for (let i = 0; i < span.length; i++) {
				const index = span.start + span.step * i,
					source = span.kind === "insert" ? span.source : undefined;
				const value = publicValue(scope, node, index, entryValue(node, index, source), source);
				if (source) {
					sources.push(source);
					indices.push(index);
					addedValues.push(value);
					order.push(-sources.length);
				} else {
					baseValues[index] = value;
					order.push(index);
				}
			}
		const baseSnapshot = new Map<number, JsonValue>(),
			insertedSnapshot = new Map<InsertSource, Map<number, JsonValue>>();
		for (const [key, value] of list.baseWrites ?? []) baseSnapshot.set(key, unstore(scope, value));
		for (const [source, values] of list.insertWrites ?? []) {
			const snapshot = new Map<number, JsonValue>();
			for (const [key, value] of values) snapshot.set(key, unstore(scope, value));
			insertedSnapshot.set(source, snapshot);
		}
		const generation = list.generation;
		order.sort((a, b) => {
			const left = a < 0 ? addedValues[-a - 1] : baseValues[a],
				right = b < 0 ? addedValues[-b - 1] : baseValues[b];
			if (typeof compare === "function") return Number(compare(left, right));
			const l = String(left),
				r = String(right);
			return l < r ? -1 : l > r ? 1 : 0;
		});
		if (baseSnapshot.size || insertedSnapshot.size || list.baseWrites?.size || list.insertWrites?.size)
			for (const token of order) {
				const source = token < 0 ? sources[-token - 1] : undefined,
					index = token < 0 ? indices[-token - 1] : token;
				const before = source ? insertedSnapshot.get(source) : baseSnapshot;
				if (before?.has(index)) writeEntry(node, index, before.get(index)!, source);
				else {
					const overrides = source ? list.insertWrites?.get(source) : list.baseWrites;
					releaseStored(scope, overrides?.get(index));
					overrides?.delete(index);
					if (source && overrides?.size === 0) list.insertWrites?.delete(source);
				}
			}
		const structural = list.generation !== generation;
		const same =
			list.length >= order.length &&
			order.every((token, i) => {
				const span = list.locate(i),
					index = span.start + span.step * list.offset;
				return (
					index === (token < 0 ? indices[-token - 1] : token) &&
					(span.kind === "insert" ? span.source === sources[-token - 1] : token >= 0)
				);
			});
		if (!same) {
			const spans: Span[] = [];
			for (const token of order) {
				const index = token < 0 ? indices[-token - 1] : token;
				appendSpan(
					spans,
					token < 0
						? { kind: "insert", source: sources[-token - 1], start: index, length: 1, step: 1 }
						: { kind: "base", start: index, length: 1, step: 1 },
				);
			}
			list.replace(0, Math.min(order.length, list.length), spans);
			mark(scope, node);
		}
		if (structural) deduplicate(node);
		return node.proxy;
	},
	fill(this: unknown, value: unknown, start?: unknown, end?: unknown) {
		const node = mutatorNode(this);
		if (!node) return Reflect.apply(Array.prototype.fill, this, [value, start, end]);
		const size = slots(node).length;
		const first = relative(start, size),
			last = relative(end, size, size);
		if (last > first)
			insertValues(
				node,
				first,
				last - first,
				Array.from({ length: last - first }, () => placement(value)),
			);
		return node.proxy;
	},
	copyWithin(this: unknown, target: unknown, start: unknown, end?: unknown) {
		const node = mutatorNode(this);
		if (!node) return Reflect.apply(Array.prototype.copyWithin, this, [target, start, end]);
		const size = slots(node).length;
		const first = relative(target, size),
			source = relative(start, size),
			last = relative(end, size, size);
		const count = Math.min(size - first, Math.max(0, last - source));
		const values = Array.from({ length: count }, (_, i) => placement(at(node.scope, node, source + i)));
		insertValues(node, first, count, values);
		return node.proxy;
	},
};

type Region = { start: number; length: number };
type DenseCandidates = { indices: number[]; bits: Uint8Array | undefined; length: number };
function includes(regions: readonly Region[], index: number): boolean {
	for (const region of regions) if (index >= region.start && index < region.start + region.length) return true;
	return false;
}
let locatedArray: Node | undefined;
let locatedIndex = 0;
function locateDense(node: Node): boolean {
	for (let child = node, parent = parentOf(child); parent; child = parent, parent = parentOf(child)) {
		if (!Array.isArray(nodeBase(parent))) continue;
		const list = slots(parent);
		if (child.parentKind !== 1 || list.structural) return false;
		const index = child.parentKey as number;
		if (entryValue(parent, index) !== nodeBase(child)) return false;
		locatedArray = parent;
		locatedIndex = index;
		return true;
	}
	return false;
}
function addDense(group: DenseCandidates, index: number): void {
	if (group.bits) {
		group.bits[index] = 1;
		return;
	}
	group.indices.push(index);
	if (group.indices.length < 256) return;
	group.bits = new Uint8Array(group.length);
	for (const value of group.indices) group.bits[value] = 1;
	group.indices.length = 0;
}
function recordDense(node: Node, groups: Map<Node, DenseCandidates>): void {
	if (!locateDense(node)) return;
	let group = groups.get(locatedArray!);
	if (!group) {
		group = { indices: [], bits: undefined, length: (nodeBase(locatedArray!) as JsonValue[]).length };
		groups.set(locatedArray!, group);
	}
	addDense(group, locatedIndex);
}
function denseRegions(group: DenseCandidates): Region[] {
	if (!group.bits) return [];
	const bits = group.bits,
		regions: Region[] = [];
	for (let index = 0; index < bits.length; ) {
		while (index < bits.length && bits[index] === 0) index++;
		if (index === bits.length) break;
		const start = index;
		let end = index,
			count = 0,
			gap = 0;
		while (index < bits.length) {
			if (bits[index] !== 0) {
				count++;
				end = index;
				gap = 0;
			} else if (++gap > 1) break;
			index++;
		}
		const length = end - start + 1;
		if (count >= 256 && count * 2 >= length) regions.push({ start, length });
	}
	return regions;
}
function coveredByRegion(node: Node, path: Path, dense: ReadonlyMap<Node, readonly Region[]>): boolean {
	for (let parent = parentOf(node); parent; parent = parentOf(parent)) {
		const regions = dense.get(parent);
		if (!regions) continue;
		const parentPath = locate(parent);
		if (!parentPath || path.length <= parentPath.length) continue;
		let matches = true;
		for (let index = 0; index < parentPath.length; index++)
			if (path[index] !== parentPath[index]) {
				matches = false;
				break;
			}
		if (!matches) continue;
		const index = path[parentPath.length];
		if (typeof index === "number" && includes(regions, index)) return true;
	}
	return false;
}
function placedAncestor(node: Node): boolean {
	for (let current: Node | undefined = node; current; current = parentOf(current))
		if (parentOf(current) && current.placement) return true;
	return false;
}
function foldedAncestor(node: Node, folded: ReadonlySet<Node>): boolean {
	for (let parent = parentOf(node); parent; parent = parentOf(parent)) if (folded.has(parent)) return true;
	return false;
}
function changedValue(operations: Op[], before: JsonValue | undefined, after: JsonValue, path: NonEmptyPath): boolean {
	if (!isContainer(after) && before === after) return false;
	if (isContainer(before) && isContainer(after) && equalJson(before, after)) return false;
	if (typeof before === "string" && typeof after === "string") {
		if (after.length > before.length && after.slice(0, before.length) === before) {
			operations.push(["a", path, after.slice(before.length)]);
			return true;
		}
		const common = overlap(before, after, 65_536);
		if (common) {
			operations.push(["t", path, before.length - common]);
			if (after.length > common) operations.push(["a", path, after.slice(common)]);
			return true;
		}
	}
	operations.push(["s", path, after]);
	return true;
}
function arrayOperations(scope: Scope, node: Node, path: Path, regions: readonly Region[], operations: Op[]): void {
	const base = nodeBase(node) as JsonValue[];
	for (const { start, length } of regions) {
		if (operations.length > 4096) return;
		const values: JsonValue[] = [];
		for (let i = start; i < start + length; i++) values.push(materialize(scope, rawAt(node, i)));
		operations.push(["p", path, start, length, values]);
	}
	if (node.slots?.structural) {
		const { removals, permutation, insertions } = node.slots.plan;
		for (let i = 0; i < removals.length; i += 2) {
			if (operations.length > 4096) return;
			operations.push(["p", path, removals[i], removals[i + 1], []]);
		}
		if (permutation) operations.push(["m", path, permutation]);
		const spans = node.slots.spans;
		for (let run = 0; run < insertions.length; run += 3) {
			if (operations.length > 4096) return;
			const values: JsonValue[] = [];
			for (let i = insertions[run + 1]; i < insertions[run + 2]; i++) {
				const span = spans[i];
				if (span.kind === "insert")
					for (let offset = 0; offset < span.length; offset++)
						values.push(materialize(scope, entryValue(node, span.start + span.step * offset, span.source)));
			}
			operations.push(["p", path, insertions[run], 0, values]);
		}
	}
	for (const [token, value] of node.slots?.baseWrites ?? []) {
		if (operations.length > 4096) return;
		const index = node.slots!.indexOf(token);
		if (index >= 0 && !includes(regions, index))
			changedValue(operations, base[token], materialize(scope, unstore(scope, value)), childPath(path, index));
	}
}
function objectWrite(scope: Scope, node: Node, path: Path, operations: Op[], key: string, value: JsonValue): boolean {
	const next = childPath(path, key);
	const before = !node.readded?.has(key) && Object.hasOwn(nodeBase(node), key) ? get(nodeBase(node), key) : undefined;
	const after = materialize(scope, value);
	const emitted = changedValue(operations, before, after, next);
	return isContainer(before) && isContainer(after) && !emitted;
}
function objectOperations(scope: Scope, node: Node, path: Path, operations: Op[]): boolean {
	let normalized = false;
	if (node.readded)
		for (const key of node.readded)
			if (Object.hasOwn(nodeBase(node), key)) operations.push(["d", childPath(path, key)]);
	if (node.writeKey !== undefined)
		normalized = objectWrite(scope, node, path, operations, node.writeKey, written(node, node.writeKey));
	if (node.writes)
		for (const [key, value] of node.writes) {
			if (operations.length > 4096) return normalized;
			if (objectWrite(scope, node, path, operations, key, unstore(scope, value))) normalized = true;
		}
	if (node.deleteKey !== undefined && Object.hasOwn(nodeBase(node), node.deleteKey)) {
		operations.push(["d", childPath(path, node.deleteKey)]);
	}
	if (node.deleted)
		for (const key of node.deleted) {
			if (operations.length > 4096) return normalized;
			if (Object.hasOwn(nodeBase(node), key)) operations.push(["d", childPath(path, key)]);
		}
	return normalized;
}
function simpleOperations(scope: Scope): Op[] | undefined {
	const candidates: Node[] = [];
	for (const node of scope.dirty) {
		if (Array.isArray(nodeBase(node))) return undefined;
		for (let current: Node | undefined = node; current; current = parentOf(current)) {
			if (Array.isArray(nodeBase(current))) return undefined;
			if (current.placement) return undefined;
		}
		if (reservedMutation(node)) return undefined;
		const path = locate(node);
		if (!path) continue;
		if (path.some((key) => typeof key === "string" && RESERVED_SEGMENTS.has(key))) return undefined;
		candidates.push(node);
		if (candidates.length > 128) return undefined;
	}
	for (let i = 1; i < candidates.length; i++) {
		const candidate = candidates[i];
		let at = i;
		while (at > 0 && candidates[at - 1].preparedPath!.length > candidate.preparedPath!.length) {
			candidates[at] = candidates[at - 1];
			at--;
		}
		candidates[at] = candidate;
	}
	const operations: Op[] = [];
	let direct = true;
	for (const node of candidates) {
		if (objectOperations(scope, node, node.preparedPath!, operations)) direct = false;
		if (operations.length > 4096) return [["r", materialize(scope, scope.bases![0])]];
	}
	scope.simple = direct;
	return operations;
}
function emit(scope: Scope): Op[] {
	const simple = simpleOperations(scope);
	if (simple) return simple;
	const operations: Op[] = [],
		folds = new Map<Node, Path>(),
		paths = new Map<Node, Path>(),
		groups = new Map<Node, DenseCandidates>();
	for (const node of scope.dirty) {
		recordDense(node, groups);
		if (!Array.isArray(nodeBase(node))) continue;
		const list = slots(node);
		if (list.structural || !list.baseWrites?.size) continue;
		let group = groups.get(node);
		if (!group) {
			group = { indices: [], bits: undefined, length: (nodeBase(node) as JsonValue[]).length };
			groups.set(node, group);
		}
		for (const index of list.baseWrites.keys()) addDense(group, index);
	}
	const dense = new Map<Node, Region[]>();
	for (const [node, group] of groups) {
		const path = locate(node);
		if (!path || path.some((segment) => typeof segment === "string" && RESERVED_SEGMENTS.has(segment))) continue;
		const regions = denseRegions(group);
		if (regions.length) dense.set(node, regions);
	}
	for (const node of scope.dirty) {
		const path = locate(node);
		if (!path || coveredByRegion(node, path, dense)) continue;
		paths.set(node, path);
		if (!Array.isArray(nodeBase(node)) && reservedMutation(node)) folds.set(node, path);
		const reserved = path.findIndex((key) => typeof key === "string" && RESERVED_SEGMENTS.has(key));
		if (reserved >= 0) {
			let ancestor = node;
			for (let depth = path.length; depth > reserved; depth--) ancestor = parentOf(ancestor)!;
			folds.set(ancestor, path.slice(0, reserved));
		}
	}
	for (const [node, path] of folds) paths.set(node, path);
	for (const node of dense.keys()) {
		const path = locate(node);
		if (path && !coveredByRegion(node, path, dense)) paths.set(node, path);
	}
	let depth = 0;
	for (const path of paths.values()) depth = Math.max(depth, path.length);
	const buckets: Node[][] = Array.from({ length: depth + 1 }, () => []);
	for (const [node, path] of paths) buckets[path.length].push(node);
	const folded = new Set<Node>();
	for (const bucket of buckets)
		for (const node of bucket) {
			const path = paths.get(node)!;
			if (placedAncestor(node) || foldedAncestor(node, folded)) continue;
			if (folds.has(node)) {
				const value = materialize(scope, nodeBase(node));
				operations.push(path.length ? ["s", path as NonEmptyPath, value] : ["r", value]);
				folded.add(node);
				continue;
			}
			if (Array.isArray(nodeBase(node))) arrayOperations(scope, node, path, dense.get(node) ?? [], operations);
			else objectOperations(scope, node, path, operations);
			if (operations.length > 4096) {
				locatedArray = undefined;
				return [["r", materialize(scope, scope.bases![0])]];
			}
		}
	locatedArray = undefined;
	return operations;
}

function ensureOperations(scope: Scope): Op[] {
	if (scope.ops) return scope.ops;
	if (settled(scope)) throw new TypeError("Cannot use a settled overlay");
	if (scope.replacement) {
		const base = scope.tracker.deref()?.replacementBase(scope);
		scope.replacementNoop = base !== undefined && equalJson(base as JsonValue, nodeBase(scope.root!) as JsonValue);
		scope.ops = scope.replacementNoop ? [] : [["r", nodeBase(scope.root!)]];
	} else scope.ops = emit(scope);
	return scope.ops;
}
function prepareCandidate<T extends object>(scope: Scope): Prepared<T> {
	const ops = ensureOperations(scope),
		base = scope.baseValue as T;
	let value: T;
	if (!ops.length) value = base;
	else if (scope.simple) value = materialize(scope, nodeBase(scope.root!)) as T;
	else {
		let structural = false;
		for (const op of ops)
			if (op[0] === "p" || op[0] === "m") {
				structural = true;
				break;
			}
		value = structural ? applyImmutable(base, ops) : applyImmutableTrusted(base, ops);
	}
	const result = new Candidate(scope, value, ops);
	close(scope, scope.nodes.length > 4096);
	return result;
}
class Candidate<T extends object> implements Prepared<T> {
	readonly #scope: Scope;
	readonly value: T;
	readonly base: T;
	readonly ops: readonly Op[];
	constructor(scope: Scope, value: T, ops: readonly Op[]) {
		this.#scope = scope;
		this.value = value;
		this.base = scope.baseValue as T;
		this.ops = ops;
		preparations.set(this, scope);
	}
	get baseRevision(): number {
		return this.#scope.revision;
	}
	abort(): void {
		abort(this.#scope);
	}
}
class Transaction<T extends object> implements Change<T> {
	#scope: Scope | undefined;
	#preparedStatus: StatusCell | undefined;
	#settled = false;
	constructor(scope: Scope) {
		this.#scope = scope;
	}
	get state(): Draft<T> {
		const state = this.#scope?.root?.proxy;
		if (state === undefined) throw new TypeError("Cannot use a settled overlay");
		return state as Draft<T>;
	}
	prepare(): Prepared<T> {
		if (this.#settled) throw new Error("Change has already been settled");
		const scope = this.#scope!;
		writable(scope.root);
		scope.status.value = "prepared";
		try {
			if (!scope.replacement) scope.ops = scope.dirty.length ? emit(scope) : [];
			const result = prepareCandidate<T>(scope);
			this.#preparedStatus = scope.status;
			this.#settled = true;
			return result;
		} catch (error) {
			scope.status.value = "aborted";
			close(scope);
			this.#settled = true;
			throw error;
		} finally {
			this.#scope = undefined;
		}
	}
	abort(): void {
		if (this.#settled) {
			if (this.#preparedStatus?.value === "prepared") this.#preparedStatus.value = "aborted";
			this.#preparedStatus = undefined;
			return;
		}
		this.#settled = true;
		abort(this.#scope!);
		this.#scope = undefined;
	}
}
class RevisionTracker<T extends object> implements Tracker<T> {
	readonly #owner = {};
	readonly #active = new Set<WeakRef<Scope>>();
	readonly #self: WeakRef<RevisionTracker<object>>;
	#value: T;
	#revision = 0;
	#pruneBudget = 256;
	constructor(value: T) {
		this.#value = value;
		this.#self = new WeakRef(this as unknown as RevisionTracker<object>);
	}
	get value(): T {
		return this.#value;
	}
	get revision(): number {
		return this.#revision;
	}
	#register(scope: Scope): void {
		const reference = new WeakRef(scope);
		scope.registryRef = reference;
		this.#active.add(reference);
		if (--this.#pruneBudget === 0) {
			for (const item of this.#active) if (!item.deref()) this.#active.delete(item);
			this.#pruneBudget = Math.max(256, this.#active.size);
		}
	}
	releaseContext(scope: Scope): void {
		if (scope.registryRef !== undefined) this.#active.delete(scope.registryRef);
		scope.registryRef = undefined;
	}
	replacementBase(scope: Scope): T | undefined {
		return scope.revision === this.#revision ? this.#value : undefined;
	}
	beginChange(): Change<T> {
		const scope = newScope(this.#self, this.#owner, this.#revision, this.#value as Container, false, this.#value);
		this.#register(scope);
		return new Transaction(scope);
	}
	prepareReplace(value: T): Prepared<T> {
		const scope = newScope(this.#self, this.#owner, this.#revision, value as Container, true, this.#value);
		scope.status.value = "prepared";
		this.#register(scope);
		try {
			return prepareCandidate<T>(scope);
		} catch (error) {
			scope.status.value = "aborted";
			close(scope);
			throw error;
		}
	}
	adopt(prepared: Prepared<T>): void {
		const scope = preparations.get(prepared);
		if (scope?.owner !== this.#owner) throw new Error("Prepared change belongs to a different tracker");
		if (scope.status.value === "consumed") throw new Error("Prepared change has already been used");
		if (scope.status.value === "aborted") throw new Error("Prepared change has been aborted");
		if (scope.status.value === "stale") throw new Error("Prepared change is stale");
		if (scope.status.value !== "prepared") throw new Error("Prepared change is not ready");
		if (scope.revision !== this.#revision) {
			scope.status.value = "stale";
			close(scope);
			throw new Error("Prepared change is stale");
		}
		if (this.#value !== prepared.base) {
			scope.status.value = "stale";
			throw new Error("Prepared change is stale");
		}
		this.#value = prepared.value;
		scope.status.value = "consumed";
		this.#revision++;
		for (const ref of this.#active) {
			const other = ref.deref();
			if (!other || other === scope) continue;
			if (other.status.value === "open" || other.status.value === "prepared") other.status.value = "stale";
			close(other, true);
		}
		this.#active.clear();
		this.#pruneBudget = 256;
	}
}
export function track<T extends object>(initial: T): Tracker<T> {
	return new RevisionTracker(initial);
}
