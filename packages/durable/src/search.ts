export type SearchDocument = { readonly name: string; readonly text: string; readonly namespaceText?: string };
const stopWords = new Set("a an and are as at be by for from in is it of on or that the this to with".split(" "));
const words = new Intl.Segmenter(undefined, { granularity: "word" });

export function tokenize(text: string): string[] {
	const normalized = text
		.normalize("NFC")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ");
	const terms = (
		/^[a-z0-9 ]*$/.test(normalized)
			? normalized.split(" ")
			: Array.from(words.segment(normalized), (part) => (part.isWordLike ? part.segment : ""))
	).filter((term) => term !== "" && !stopWords.has(term));
	return terms.map((term) => {
		if (!/^[a-z0-9]+$/.test(term)) return term;
		if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
		if (term.length > 4 && /(?:ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
		return term.length > 3 && term.endsWith("s") && !term.endsWith("ss") ? term.slice(0, -1) : term;
	});
}

export function rankDocuments(query: string, documents: readonly SearchDocument[], limit: number): string[] {
	const terms = [...new Set(tokenize(query))];
	if (!terms.length || !documents.length || limit <= 0) return [];
	const rows = documents.map((document) => {
		const tokens = tokenize(document.text),
			counts = new Map<string, number>();
		for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
		return {
			counts,
			length: tokens.length,
			name: new Set(tokenize(document.name)),
			local: tokenize(document.name.split("__").at(-1)!),
			namespace: new Set(tokenize(document.namespaceText ?? "")),
		};
	});
	const average = rows.reduce((sum, row) => sum + row.length, 0) / rows.length || 1;
	const weights = terms.map((term) => {
		const frequency = rows.reduce(
			(sum, row) => sum + Number(row.counts.has(term) || row.name.has(term) || row.namespace.has(term)),
			0,
		);
		return Math.log(1 + (rows.length - frequency + 0.5) / (frequency + 0.5));
	});
	const bonus = weights.reduce((sum, weight) => sum + weight, 0);
	const normalizeName = (name: string) =>
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9_$]/g, "_");
	const exact = normalizeName(query);
	return rows
		.map((row, index) => {
			let score = 0,
				covered = 0;
			for (let position = 0; position < terms.length; position++) {
				const term = terms[position]!,
					count = row.counts.get(term) ?? 0;
				const weight =
					(row.name.has(term) ? 3 : 0) +
					(row.namespace.has(term) ? 0.5 : 0) +
					(count * 2.2) / (count + 1.2 * (0.25 + (0.75 * row.length) / average));
				if (weight > 0) covered++;
				score += weights[position]! * weight;
			}
			const name = documents[index]!.name;
			return {
				name,
				score: score > 0 && row.local.length && row.local.every((term) => terms.includes(term)) ? score + bonus : score,
				covered,
				exact: normalizeName(name) === exact || normalizeName(name).endsWith(`__${exact}`),
			};
		})
		.filter((item) => item.score > 0)
		.sort((a, b) => Number(b.exact) - Number(a.exact) || b.covered - a.covered || b.score - a.score)
		.slice(0, limit)
		.map((item) => item.name);
}
