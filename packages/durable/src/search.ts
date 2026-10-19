export type SearchDocument = { readonly name: string; readonly text: string };
const stopWords = new Set("a an and are as at be by for from in is it of on or that the this to with".split(" "));

export function tokenize(text: string): string[] {
	const terms = text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term !== "" && !stopWords.has(term));
	return terms.map((term) => {
		if (term.length > 4 && term.endsWith("ies")) return term.slice(0, -3) + "y";
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
		return { counts, length: tokens.length };
	});
	const average = rows.reduce((sum, row) => sum + row.length, 0) / rows.length || 1;
	const weights = terms.map((term) => {
		const frequency = rows.reduce((sum, row) => sum + Number(row.counts.has(term)), 0);
		return Math.log(1 + (rows.length - frequency + 0.5) / (frequency + 0.5));
	});
	return rows
		.map((row, index) => {
			let score = 0;
			for (let position = 0; position < terms.length; position++) {
				const count = row.counts.get(terms[position]!);
				if (count)
					score += weights[position]! * ((count * 2.2) / (count + 1.2 * (0.25 + (0.75 * row.length) / average)));
			}
			return { name: documents[index]!.name, score };
		})
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((item) => item.name);
}
