export type StoredRef = null | boolean | number | string | { index: number };
export type InsertSource = { refs: StoredRef[] };
type Range = { start: number; length: number; step: 1 | -1 };
export type Span = Range & ({ kind: "base" } | { kind: "insert"; source: InsertSource });
type Plan = { removals: number[]; permutation?: number[]; insertions: number[] };
type Branch = { span: Span; priority: number; count: number; left?: Branch; right?: Branch };
type Location = { span: Span; offset: number; minimum: number; maximum: number };
const count = (branch: Branch | undefined): number => branch?.count ?? 0;
function refresh(branch: Branch): Branch {
	branch.count = count(branch.left) + branch.span.length + count(branch.right);
	return branch;
}
function merge(left: Branch | undefined, right: Branch | undefined): Branch | undefined {
	if (!left) return right;
	if (!right) return left;
	if (left.priority >= right.priority) {
		left.right = merge(left.right, right);
		return refresh(left);
	}
	right.left = merge(left, right.left);
	return refresh(right);
}
function collect(branch: Branch | undefined, spans: Span[]): void {
	if (!branch) return;
	collect(branch.left, spans);
	spans.push(branch.span);
	collect(branch.right, spans);
}
function collapse(spans: Span[]): void {
	for (let index = 1; index < spans.length; ) {
		const left = spans[index - 1],
			right = spans[index];
		const shared =
			left.kind === right.kind && (left.kind === "base" || (right.kind === "insert" && left.source === right.source));
		const distance = right.start - left.start;
		if (shared && left.length === 1 && right.length === 1 && (distance === 1 || distance === -1)) {
			left.step = distance;
			left.length = 2;
			spans.splice(index, 1);
		} else if (shared && left.step === right.step && left.start + left.step * left.length === right.start) {
			left.length += right.length;
			spans.splice(index, 1);
		} else index++;
	}
}
function boundary(branch: Branch, side: "left" | "right"): Branch {
	while (branch[side]) branch = branch[side];
	return branch;
}
function combined(left: Span, right: Span): Span | undefined {
	if (left.kind !== right.kind || (left.kind === "insert" && right.kind === "insert" && left.source !== right.source))
		return undefined;
	let step = left.step;
	if (left.length === 1 && right.length === 1) {
		const distance = right.start - left.start;
		if (distance !== 1 && distance !== -1) return undefined;
		step = distance;
	} else if (left.step !== right.step || left.start + left.step * left.length !== right.start) return undefined;
	return { ...left, length: left.length + right.length, step };
}
function orderedRemovals(length: number, spans: readonly Span[]): number[] | undefined {
	const ranges: number[] = [];
	for (const span of spans) {
		if (span.kind !== "base" || !span.length) continue;
		if ((span.step !== 1 && span.length > 1) || (ranges.length > 0 && span.start <= ranges[ranges.length - 1]))
			return undefined;
		ranges.push(span.start, span.start + span.length - 1);
	}
	const removals: number[] = [];
	let end = length;
	for (let i = ranges.length - 2; i >= -2; i -= 2) {
		const start = i < 0 ? 0 : ranges[i + 1] + 1;
		if (end > start) removals.push(start, end - start);
		if (i >= 0) end = ranges[i];
	}
	return removals;
}
function insertionRuns(spans: readonly Span[]): number[] {
	const runs: number[] = [];
	let logical = 0;
	for (let i = 0; i < spans.length; ) {
		if (spans[i].kind === "base") {
			logical += spans[i++].length;
			continue;
		}
		const start = i;
		while (i < spans.length && spans[i].kind === "insert") logical += spans[i++].length;
		let length = 0;
		for (let j = start; j < i; j++) length += spans[j].length;
		runs.push(logical - length, start, i);
	}
	return runs;
}

export class ArrayLayout {
	#root: Branch | undefined;
	#seed = 0x9e3779b9;
	#spans: Span[] | undefined;
	#basePositions: Location[] | undefined;
	#insertPositions: Map<InsertSource, Location[]> | undefined;
	#plan: Plan | undefined;
	baseWrites: Map<number, StoredRef> | undefined;
	insertWrites: Map<InsertSource, Map<number, StoredRef>> | undefined;
	structural = false;
	generation = 0;
	offset = 0;
	readonly baseLength: number;
	constructor(baseLength: number) {
		this.baseLength = baseLength;
		const length = baseLength;
		if (length) this.#root = this.#branch({ kind: "base", start: 0, length, step: 1 });
	}
	#branch(span: Span): Branch {
		let next = this.#seed;
		next ^= next << 13;
		next ^= next >>> 17;
		next ^= next << 5;
		this.#seed = next >>> 0;
		return { span, priority: this.#seed, count: span.length };
	}
	#tree(spans: Span[]): Branch | undefined {
		collapse(spans);
		let root: Branch | undefined;
		for (const span of spans) root = merge(root, this.#branch(span));
		return root;
	}
	#invalidate(): void {
		this.#spans = undefined;
		this.#basePositions = undefined;
		this.#insertPositions = undefined;
		this.#plan = undefined;
		this.structural = true;
		this.generation++;
	}
	get spans(): readonly Span[] {
		if (!this.#spans) {
			const spans: Span[] = [];
			collect(this.#root, spans);
			this.#spans = spans;
		}
		return this.#spans;
	}
	get length(): number {
		return count(this.#root);
	}
	set length(next: number) {
		if (next < this.length) this.replace(next, this.length - next, []);
		else if (next > this.length) {
			this.insert(
				this.length,
				0,
				Array.from({ length: next - this.length }, () => null),
			);
		}
	}
	locate(index: number): Span {
		let branch = this.#root;
		while (branch) {
			const left = count(branch.left);
			if (index < left) branch = branch.left;
			else if (index >= left + branch.span.length) {
				index -= left + branch.span.length;
				branch = branch.right;
			} else {
				this.offset = index - left;
				return branch.span;
			}
		}
		throw new RangeError("Array index is out of range");
	}
	indexOf(index: number, source?: InsertSource): number {
		if (source === undefined && !this.structural) return index;
		if (!this.#basePositions) {
			const base: Location[] = (this.#basePositions = []),
				inserted = (this.#insertPositions = new Map<InsertSource, Location[]>());
			let offset = 0;
			for (const span of this.spans) {
				const end = span.start + span.step * (span.length - 1);
				const location = { span, offset, minimum: Math.min(span.start, end), maximum: Math.max(span.start, end) };
				if (span.kind === "base") base.push(location);
				else {
					let locations = inserted.get(span.source);
					if (!locations) inserted.set(span.source, (locations = []));
					locations.push(location);
				}
				offset += span.length;
			}
			const byMinimum = (a: Location, b: Location): number => a.minimum - b.minimum;
			base.sort(byMinimum);
			for (const locations of inserted.values()) locations.sort(byMinimum);
		}
		const ranges = source ? this.#insertPositions!.get(source) : this.#basePositions;
		if (!ranges) return -1;
		let low = 0,
			high = ranges.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (ranges[middle].minimum <= index) low = middle + 1;
			else high = middle;
		}
		const location = ranges[low - 1];
		return location && index <= location.maximum
			? location.offset + (index - location.span.start) / location.span.step
			: -1;
	}
	#split(branch: Branch | undefined, index: number): [Branch | undefined, Branch | undefined] {
		if (!branch) return [undefined, undefined];
		const leftLength = count(branch.left),
			end = leftLength + branch.span.length;
		if (index < leftLength) {
			const [left, right] = this.#split(branch.left, index);
			branch.left = right;
			return [left, refresh(branch)];
		}
		if (index > end) {
			const [left, right] = this.#split(branch.right, index - end);
			branch.right = left;
			return [refresh(branch), right];
		}
		if (index === leftLength) {
			const left = branch.left;
			branch.left = undefined;
			return [left, refresh(branch)];
		}
		if (index === end) {
			const right = branch.right;
			branch.right = undefined;
			return [refresh(branch), right];
		}
		const offset = index - leftLength,
			span = branch.span;
		return [
			merge(branch.left, this.#branch({ ...span, length: offset })),
			merge(
				this.#branch({ ...span, start: span.start + span.step * offset, length: span.length - offset }),
				branch.right,
			),
		];
	}
	#join(left: Branch | undefined, right: Branch | undefined): Branch | undefined {
		if (!left) return right;
		if (!right) return left;
		const last = boundary(left, "right").span,
			first = boundary(right, "left").span;
		const span = combined(last, first);
		if (!span) return merge(left, right);
		const [head] = this.#split(left, count(left) - last.length);
		const [, tail] = this.#split(right, first.length);
		return this.#join(this.#join(head, this.#branch(span)), tail);
	}
	#extend(branch: Branch, amount: number): void {
		if (branch.right) this.#extend(branch.right, amount);
		else branch.span.length += amount;
		refresh(branch);
	}
	insert(start: number, remove: number, refs: StoredRef[], offset = 0): void {
		this.replace(
			start,
			remove,
			refs.length > offset
				? [{ kind: "insert", source: { refs }, start: offset, length: refs.length - offset, step: 1 }]
				: [],
		);
	}
	replace(start: number, remove: number, spans: Span[]): void {
		if (!remove && !spans.length) return;
		if (!remove && start === this.length && spans.length === 1 && this.#root) {
			const last = boundary(this.#root, "right").span;
			const addition = spans[0];
			if (
				addition.kind === "insert" &&
				last.kind === "insert" &&
				last.step === 1 &&
				last.start + last.length === last.source.refs.length
			) {
				for (let i = 0; i < addition.length; i++) last.source.refs.push(addition.source.refs[addition.start + i]);
				this.#extend(this.#root, addition.length);
				this.#invalidate();
				return;
			}
		}
		const [left, rest] = this.#split(this.#root, start);
		const [, right] = this.#split(rest, remove);
		const additions = this.#tree(spans);
		this.#root = this.#join(this.#join(left, additions), right);
		this.#invalidate();
	}
	clear(): void {
		if (this.#spans) this.#spans.length = 0;
		this.#root = undefined;
		this.#basePositions = undefined;
		this.#insertPositions = undefined;
		this.baseWrites?.clear();
		this.insertWrites?.clear();
	}
	get plan(): Plan {
		if (this.#plan) return this.#plan;
		const spans = this.spans;
		const ordered = orderedRemovals(this.baseLength, spans);
		const removals = ordered ?? [];
		let permutation: number[] | undefined;
		if (ordered === undefined) {
			const used = new Uint8Array(this.baseLength),
				retained: number[] = [];
			for (const span of spans)
				if (span.kind === "base")
					for (let i = 0; i < span.length; i++) {
						const index = span.start + span.step * i;
						used[index] = 1;
						retained.push(index);
					}
			for (let end = used.length; end > 0; ) {
				if (used[end - 1]) {
					end--;
					continue;
				}
				let start = end - 1;
				while (start > 0 && !used[start - 1]) start--;
				removals.push(start, end - start);
				end = start;
			}
			const sorted: number[] = [];
			for (let i = 0; i < used.length; i++) if (used[i]) sorted.push(i);
			if (retained.some((value, i) => value !== sorted[i])) {
				const positions = new Map(sorted.map((value, i) => [value, i]));
				permutation = retained.map((value) => positions.get(value)!);
			}
		}
		return (this.#plan = { removals, permutation, insertions: insertionRuns(spans) });
	}
	reverse(): void {
		const spans = [...this.spans].reverse();
		for (const span of spans) {
			span.start += span.step * (span.length - 1);
			span.step = span.step === 1 ? -1 : 1;
		}
		this.#root = this.#tree(spans);
		this.#invalidate();
	}
}
