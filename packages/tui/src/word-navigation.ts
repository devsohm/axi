export interface WordNavigationOptions {
	segment?: (text: string) => Iterable<Intl.SegmentData>;
	isAtomicSegment?: (segment: string) => boolean;
}

const words = new Intl.Segmenter(undefined, { granularity: "word" });
const punctuation = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/;
const whitespace = (value: string): boolean => /\s/.test(value);

export function findWordForward(text: string, cursor: number, options?: WordNavigationOptions): number {
	if (cursor >= text.length) return text.length;
	const remaining = text.slice(cursor);
	const segment = options?.segment;
	const isAtomic = options?.isAtomicSegment;
	const iterator = (segment ? segment(remaining) : words.segment(remaining))[Symbol.iterator]();
	let current = iterator.next();
	let position = cursor;
	while (!current.done && !isAtomic?.(current.value.segment) && whitespace(current.value.segment)) {
		position += current.value.segment.length;
		current = iterator.next();
	}
	if (current.done) return position;
	if (isAtomic?.(current.value.segment)) position += current.value.segment.length;
	else if (current.value.isWordLike)
		position += punctuation.exec(current.value.segment)?.index ?? current.value.segment.length;
	else {
		while (
			!current.done &&
			!isAtomic?.(current.value.segment) &&
			!current.value.isWordLike &&
			!whitespace(current.value.segment)
		) {
			position += current.value.segment.length;
			current = iterator.next();
		}
	}
	return position;
}

export function findWordBackward(text: string, cursor: number, options?: WordNavigationOptions): number {
	if (cursor <= 0) return 0;
	const preceding = text.slice(0, cursor);
	const segment = options?.segment;
	const isAtomic = options?.isAtomicSegment;
	const parts = [...(segment ? segment(preceding) : words.segment(preceding))];
	let position = cursor;
	let part = parts.at(-1);
	while (part && !isAtomic?.(part.segment) && whitespace(part.segment)) {
		position -= part.segment.length;
		parts.pop();
		part = parts.at(-1);
	}
	if (!part) return position;
	if (isAtomic?.(part.segment)) position -= part.segment.length;
	else if (part.isWordLike) {
		let boundary = 0;
		for (let offset = 0; offset < part.segment.length; offset++) {
			if (punctuation.test(part.segment[offset])) boundary = offset + 1;
		}
		position -= part.segment.length - boundary;
	} else {
		while (part && !isAtomic?.(part.segment) && !part.isWordLike && !whitespace(part.segment)) {
			position -= part.segment.length;
			parts.pop();
			part = parts.at(-1);
		}
	}
	return position;
}
