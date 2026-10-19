import type { JsonValue } from "../json.ts";
import { type NonEmptyPath, type Op, overlap, type Path, RESERVED_SEGMENTS } from "./index.ts";

type Dictionary = Record<string, JsonValue>;
type Match = readonly [number, number];
const object = (value: JsonValue): value is Dictionary | JsonValue[] => value !== null && typeof value === "object";
const overflow = new WeakSet<Op[]>();

function record(operations: Op[], operation: Op): void {
	if (overflow.has(operations)) return;
	if (operations.length >= 4096) overflow.add(operations);
	else operations.push(operation);
}

function setValue(path: Path, value: JsonValue, operations: Op[]): void {
	record(operations, path.length ? ["s", path as NonEmptyPath, value] : ["r", value]);
}

export function equalJson(left: JsonValue, right: JsonValue): boolean {
	if (left === right) return true;
	if (!object(left) || !object(right) || Array.isArray(left) !== Array.isArray(right)) return false;
	if (Array.isArray(left)) {
		const values = right as JsonValue[];
		if (left.length !== values.length) return false;
		for (let i = 0; i < left.length; i++) if (!equalJson(left[i], values[i])) return false;
		return true;
	}
	const values = right as Dictionary;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(values).length) return false;
	for (const key of keys) if (!Object.hasOwn(values, key) || !equalJson(left[key], values[key])) return false;
	return true;
}

function stringDiff(before: string, after: string, path: NonEmptyPath, operations: Op[]): void {
	if (before === after) return;
	if (after.length > before.length && after.slice(0, before.length) === before) {
		record(operations, ["a", path, after.slice(before.length)]);
		return;
	}
	const common = overlap(before, after, 65_536);
	if (!common) record(operations, ["s", path, after]);
	else {
		record(operations, ["t", path, before.length - common]);
		if (after.length > common) record(operations, ["a", path, after.slice(common)]);
	}
}

function semanticMatch(left: JsonValue, right: JsonValue): boolean {
	if (equalJson(left, right)) return true;
	if (!object(left) || !object(right) || Array.isArray(left) !== Array.isArray(right)) return false;
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.some((entry, index) => object(entry) && entry === right[index]);
	}
	const before = left as Dictionary,
		after = right as Dictionary;
	for (const key of Object.keys(before)) {
		const entry = before[key];
		if (object(entry) && Object.hasOwn(after, key) && entry === after[key]) return true;
	}
	return false;
}

function semanticAnchors(before: JsonValue[], after: JsonValue[]): Match[] | undefined {
	if (!before.length || !after.length) return [];
	if (before.length * after.length > 65_536) return undefined;
	const width = after.length + 1;
	const table = new Uint32Array((before.length + 1) * width);
	for (let i = before.length - 1; i >= 0; i--) {
		for (let j = after.length - 1; j >= 0; j--) {
			table[i * width + j] = semanticMatch(before[i], after[j])
				? 1 + table[(i + 1) * width + j + 1]
				: Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
		}
	}
	const matches: Match[] = [];
	for (let i = 0, j = 0; i < before.length && j < after.length; ) {
		if (semanticMatch(before[i], after[j]) && table[i * width + j] === 1 + table[(i + 1) * width + j + 1]) {
			matches.push([i++, j++]);
		} else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
		else j++;
	}
	return matches;
}

function lowerBound(values: readonly number[], target: number): number {
	let low = 0,
		high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (values[middle] < target) low = middle + 1;
		else high = middle;
	}
	return low;
}

function subsequence(
	before: JsonValue[],
	start: number,
	end: number,
	after: JsonValue[],
	nextStart: number,
	nextEnd: number,
): Match[] | undefined {
	const matches: Match[] = [];
	if (nextEnd - nextStart < end - start) {
		let i = start;
		for (let j = nextStart; j < nextEnd; j++) {
			while (i < end && before[i] !== after[j]) i++;
			if (i === end) return undefined;
			matches.push([i++, j]);
		}
		return matches;
	}
	if (end - start < nextEnd - nextStart) {
		let j = nextStart;
		for (let i = start; i < end; i++) {
			while (j < nextEnd && before[i] !== after[j]) j++;
			if (j === nextEnd) return undefined;
			matches.push([i, j++]);
		}
		return matches;
	}
	return undefined;
}

function greedyAnchors(
	positions: ReadonlyMap<JsonValue, readonly number[]>,
	after: JsonValue[],
	start: number,
	end: number,
): Match[] {
	const matches: Match[] = [];
	let previous = -1;
	for (let j = start; j < end; j++) {
		const candidates = positions.get(after[j]);
		if (candidates === undefined) continue;
		const i = candidates[lowerBound(candidates, previous + 1)];
		if (i === undefined) continue;
		matches.push([i, j]);
		previous = i;
	}
	return matches;
}

function identityAnchors(
	before: JsonValue[],
	start: number,
	end: number,
	after: JsonValue[],
	nextStart: number,
	nextEnd: number,
): Match[] {
	const positions = new Map<JsonValue, number[]>();
	for (let i = start; i < end; i++) {
		const indices = positions.get(before[i]);
		if (indices === undefined) positions.set(before[i], [i]);
		else indices.push(i);
	}
	let count = 0;
	for (let j = nextStart; j < nextEnd; j++) {
		count += positions.get(after[j])?.length ?? 0;
		if (count > 200_000) return greedyAnchors(positions, after, nextStart, nextEnd);
	}
	if (!count) return [];
	const candidates: { before: number; after: number; previous: number }[] = [];
	const tails: number[] = [],
		values: number[] = [];
	for (let j = nextStart; j < nextEnd; j++) {
		const indices = positions.get(after[j]);
		if (indices === undefined) continue;
		for (let k = indices.length - 1; k >= 0; k--) {
			const i = indices[k],
				slot = lowerBound(values, i);
			candidates.push({ before: i, after: j, previous: slot === 0 ? -1 : tails[slot - 1] });
			tails[slot] = candidates.length - 1;
			values[slot] = i;
		}
	}
	const matches: Match[] = [];
	for (let at = tails[tails.length - 1] ?? -1; at >= 0; at = candidates[at].previous) {
		const entry = candidates[at];
		matches.push([entry.before, entry.after]);
	}
	return matches.reverse();
}

function diffMatches(
	before: JsonValue[],
	after: JsonValue[],
	path: Path,
	operations: Op[],
	start: number,
	end: number,
	nextStart: number,
	nextEnd: number,
	offset: number,
	matches: readonly Match[],
): void {
	let i = start,
		j = nextStart,
		output = offset;
	for (const [left, right] of matches) {
		if (overflow.has(operations)) return;
		arrayRegion(before, after, path, operations, i, left, j, right, output);
		output += right - j;
		if (!equalJson(before[left], after[right])) walkDiff(before[left], after[right], [...path, output], operations);
		output++;
		i = left + 1;
		j = right + 1;
	}
	if (!overflow.has(operations)) arrayRegion(before, after, path, operations, i, end, j, nextEnd, output);
}

function arrayRegion(
	before: JsonValue[],
	after: JsonValue[],
	path: Path,
	operations: Op[],
	start: number,
	end: number,
	nextStart: number,
	nextEnd: number,
	offset: number,
): void {
	if (overflow.has(operations)) return;
	while (start < end && nextStart < nextEnd && equalJson(before[start], after[nextStart])) {
		start++;
		nextStart++;
		offset++;
	}
	while (start < end && nextStart < nextEnd && equalJson(before[end - 1], after[nextEnd - 1])) {
		end--;
		nextEnd--;
	}
	const size = end - start,
		nextSize = nextEnd - nextStart;
	if (!size && !nextSize) return;
	if (!size || !nextSize) {
		record(operations, ["p", path, offset, size, after.slice(nextStart, nextEnd)]);
		return;
	}
	if (size === nextSize) {
		const positional: Match[] = [];
		for (let i = 0; i < size; i++) {
			if (equalJson(before[start + i], after[nextStart + i])) positional.push([start + i, nextStart + i]);
		}
		if (positional.length) {
			diffMatches(before, after, path, operations, start, end, nextStart, nextEnd, offset, positional);
			return;
		}
	}
	const subset = subsequence(before, start, end, after, nextStart, nextEnd);
	if (subset !== undefined && subset.length) {
		diffMatches(before, after, path, operations, start, end, nextStart, nextEnd, offset, subset);
		return;
	}
	const identity = identityAnchors(before, start, end, after, nextStart, nextEnd);
	if (identity.length) {
		diffMatches(before, after, path, operations, start, end, nextStart, nextEnd, offset, identity);
		return;
	}
	const semantic = semanticAnchors(before.slice(start, end), after.slice(nextStart, nextEnd));
	if (semantic !== undefined && semantic.length) {
		const absolute = semantic.map(([i, j]) => [start + i, nextStart + j] as const);
		diffMatches(before, after, path, operations, start, end, nextStart, nextEnd, offset, absolute);
		return;
	}
	if (size === 1 && nextSize === 1) walkDiff(before[start], after[nextStart], [...path, offset], operations);
	else record(operations, ["p", path, offset, size, after.slice(nextStart, nextEnd)]);
}

function reorder(before: JsonValue[], after: JsonValue[]): number[] | undefined {
	if (before.length !== after.length) return undefined;
	const positions = new Map<JsonValue, { indices: number[]; used: number }>();
	for (let i = 0; i < before.length; i++) {
		const entry = positions.get(before[i]);
		if (entry === undefined) positions.set(before[i], { indices: [i], used: 0 });
		else entry.indices.push(i);
	}
	const order = new Array<number>(after.length);
	for (let i = 0; i < after.length; i++) {
		const entry = positions.get(after[i]);
		if (entry === undefined || entry.used === entry.indices.length) return undefined;
		order[i] = entry.indices[entry.used++];
	}
	return order;
}

function walkDiff(before: JsonValue, after: JsonValue, path: Path, operations: Op[]): void {
	if (before === after || overflow.has(operations)) return;
	if (typeof before === "string" && typeof after === "string" && path.length) {
		stringDiff(before, after, path as NonEmptyPath, operations);
	} else if (Array.isArray(before) && Array.isArray(after)) {
		if (equalJson(before, after)) return;
		if (
			before.length === after.length &&
			before.length > 1 &&
			!equalJson(before[0], after[0]) &&
			!equalJson(before[before.length - 1], after[after.length - 1])
		) {
			const order = reorder(before, after);
			if (order !== undefined) {
				record(operations, ["m", path, order]);
				return;
			}
		}
		arrayRegion(before, after, path, operations, 0, before.length, 0, after.length, 0);
	} else if (object(before) && object(after) && !Array.isArray(before) && !Array.isArray(after)) {
		const beforeKeys = Object.keys(before),
			afterKeys = Object.keys(after);
		if ([...beforeKeys, ...afterKeys].some((key) => RESERVED_SEGMENTS.has(key))) {
			if (!equalJson(before, after)) setValue(path, after, operations);
			return;
		}
		for (const key of afterKeys) {
			if (overflow.has(operations)) return;
			if (Object.hasOwn(before, key)) walkDiff(before[key], after[key], [...path, key], operations);
			else setValue([...path, key], after[key], operations);
		}
		for (const key of beforeKeys) {
			if (overflow.has(operations)) return;
			if (!Object.hasOwn(after, key)) record(operations, ["d", [...path, key] as unknown as NonEmptyPath]);
		}
	} else setValue(path, after, operations);
}

function jsonCost(value: JsonValue): number {
	if (value === null) return 4;
	if (typeof value === "string") return value.length + 2;
	if (typeof value === "number") return String(value).length;
	if (typeof value === "boolean") return value ? 4 : 5;
	let size = 2;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) size += jsonCost(value[i]) + (i ? 1 : 0);
	} else {
		let i = 0;
		for (const key of Object.keys(value)) size += key.length + 3 + jsonCost(value[key]) + (i++ ? 1 : 0);
	}
	return size;
}

function pathCost(path: Path): number {
	let size = 2;
	for (let i = 0; i < path.length; i++) {
		const segment = path[i];
		size += (typeof segment === "string" ? segment.length + 2 : String(segment).length) + (i ? 1 : 0);
	}
	return size;
}

function operationCost(operation: Op): number {
	switch (operation[0]) {
		case "r":
			return 6 + jsonCost(operation[1]);
		case "s":
			return 7 + pathCost(operation[1]) + jsonCost(operation[2]);
		case "d":
			return 6 + pathCost(operation[1]);
		case "a":
			return 7 + pathCost(operation[1]) + operation[2].length + 2;
		case "t":
			return 7 + pathCost(operation[1]) + String(operation[2]).length;
		case "p":
			return (
				10 + pathCost(operation[1]) + String(operation[2]).length + String(operation[3]).length + jsonCost(operation[4])
			);
		case "m":
			return 7 + pathCost(operation[1]) + jsonCost(operation[2]);
	}
}

export function diffRevisions(before: JsonValue, after: JsonValue): Op[] {
	const operations: Op[] = [];
	walkDiff(before, after, [], operations);
	if (overflow.has(operations)) return [["r", after]];
	if (!operations.length || operations[0][0] === "r") return operations;
	let size = 2;
	for (const operation of operations) size += operationCost(operation) + 1;
	if (size < 65_536) return operations;
	return size >= jsonCost(after) + 6 ? [["r", after]] : operations;
}
