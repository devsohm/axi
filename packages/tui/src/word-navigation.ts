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
	let position = cursor;
	let inPunctuation = false;
	for (const part of options?.segment?.(remaining) ?? words.segment(remaining)) {
		const atomic = options?.isAtomicSegment?.(part.segment) ?? false;
		if (!atomic && whitespace(part.segment)) {
			if (inPunctuation) break;
			position += part.segment.length;
			continue;
		}
		if (atomic || part.isWordLike) {
			if (!inPunctuation)
				position += atomic ? part.segment.length : (punctuation.exec(part.segment)?.index ?? part.segment.length);
			break;
		}
		inPunctuation = true;
		position += part.segment.length;
	}
	return position;
}

export function findWordBackward(text: string, cursor: number, options?: WordNavigationOptions): number {
	if (cursor <= 0) return 0;
	const preceding = text.slice(0, cursor);
	const parts = [...(options?.segment?.(preceding) ?? words.segment(preceding))];
	let position = cursor;
	let inPunctuation = false;
	for (let index = parts.length - 1; index >= 0; index--) {
		const part = parts[index];
		const atomic = options?.isAtomicSegment?.(part.segment) ?? false;
		if (!atomic && whitespace(part.segment)) {
			if (inPunctuation) break;
			position -= part.segment.length;
			continue;
		}
		if (atomic || part.isWordLike) {
			if (!inPunctuation) {
				let boundary = 0;
				if (!atomic) {
					for (let offset = 0; offset < part.segment.length; offset++) {
						if (punctuation.test(part.segment[offset])) boundary = offset + 1;
					}
				}
				position -= part.segment.length - boundary;
			}
			break;
		}
		inPunctuation = true;
		position -= part.segment.length;
	}
	return position;
}
