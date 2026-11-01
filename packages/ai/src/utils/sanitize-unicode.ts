export function sanitizeSurrogates(text: string): string {
	let result = "";
	for (const character of text) {
		const code = character.codePointAt(0)!;
		if (code < 0xd800 || code > 0xdfff) result += character;
	}
	return result;
}
