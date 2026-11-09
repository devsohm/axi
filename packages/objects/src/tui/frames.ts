export const FRAME_UNITS = 16 * 1024;
export function splitFrames(data: string): string[] {
	const frames: string[] = [];
	let start = 0,
		cursor = 0;
	while (cursor < data.length) {
		const before = cursor;
		if (data[cursor] === "\x1b") {
			const type = data[++cursor];
			cursor++;
			if (type === "[") {
				while (cursor < data.length && /[ -?]/.test(data[cursor]!)) cursor++;
				cursor = Math.min(cursor + 1, data.length);
			} else if (type && "]PX^_".includes(type)) {
				while (cursor < data.length) {
					if (data[cursor++] === "\x07") break;
					if (data[cursor - 1] === "\x1b" && data[cursor] === "\\") {
						cursor++;
						break;
					}
				}
			} else cursor = Math.min(cursor, data.length);
		} else {
			const unit = data.charCodeAt(cursor++);
			if (unit >= 0xd800 && unit <= 0xdbff && cursor < data.length) cursor++;
		}
		if (cursor - start > FRAME_UNITS && before > start) {
			frames.push(data.slice(start, before));
			start = before;
		}
	}
	frames.push(data.slice(start));
	return frames;
}
