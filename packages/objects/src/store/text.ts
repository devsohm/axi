import { invalid } from "../data/errors.ts";

export function compareText(a: string, b: string): number {
	const left = a[Symbol.iterator](),
		right = b[Symbol.iterator]();
	for (;;) {
		const x = left.next(),
			y = right.next();
		if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
		const order = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
		if (order) return order;
	}
}
export function storedText(value: string, label: string): string {
	if (value.includes("\0")) throw invalid("args", `${label}: text may not contain NUL`);
	return value.isWellFormed() ? value : value.toWellFormed();
}
export function prefixUpperBound(prefix: string): string | undefined {
	for (let end = prefix.length; end > 0; ) {
		const low = prefix.charCodeAt(--end);
		const paired = low >= 0xdc00 && low <= 0xdfff;
		if (paired) end--;
		const point = prefix.codePointAt(end)!;
		if (point === 0x10ffff) continue;
		return prefix.slice(0, end) + String.fromCodePoint(point === 0xd7ff ? 0xe000 : point + 1);
	}
	return undefined;
}
