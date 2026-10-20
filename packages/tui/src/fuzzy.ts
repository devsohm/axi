export interface FuzzyMatch {
	matches: boolean;
	score: number;
}

function scoreQuery(query: string, text: string): FuzzyMatch {
	if (!query) return { matches: true, score: 0 };
	let previous = -1;
	let streak = 0;
	let score = 0;
	for (let index = 0; index < query.length; index++) {
		const position = text.indexOf(query[index], previous + 1);
		if (position < 0) return { matches: false, score: 0 };
		if (position === previous + 1) score -= ++streak * 5;
		else {
			streak = 0;
			if (previous >= 0) score += 2 * (position - previous - 1);
		}
		if (position === 0 || /[\s\-_./:]/.test(text[position - 1])) score -= 10;
		score += position * 0.1;
		previous = position;
	}
	return { matches: true, score: score - (query === text ? 100 : 0) };
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	const needle = query.toLowerCase();
	const haystack = text.toLowerCase();
	const primary = scoreQuery(needle, haystack);
	if (primary.matches) return primary;
	const groups = /^([a-z]+)(\d+)$/.exec(needle) ?? /^(\d+)([a-z]+)$/.exec(needle);
	if (!groups) return primary;
	const alternative = scoreQuery(groups[2] + groups[1], haystack);
	return alternative.matches ? { matches: true, score: alternative.score + 5 } : primary;
}

export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	const tokens = query
		.trim()
		.split(/[\s/]+/)
		.filter(Boolean);
	if (!tokens.length) return items;
	const ranked: { value: T; score: number }[] = [];
	for (const value of items) {
		const text = getText(value);
		const results = tokens.map((token) => fuzzyMatch(token, text));
		if (results.every((result) => result.matches))
			ranked.push({ value, score: results.reduce((sum, result) => sum + result.score, 0) });
	}
	return ranked.sort((left, right) => left.score - right.score).map(({ value }) => value);
}
