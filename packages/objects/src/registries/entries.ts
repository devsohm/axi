import type { ComposeContext, RegistryTable } from "./registry.ts";

export type TableItem<I> = { readonly value: I; readonly plugin: string; readonly type?: string };
function item<I>(value: I, plugin: string, type: string | undefined): TableItem<I> {
	return { value, plugin, ...(type === undefined ? {} : { type }) };
}
export function keyedEntries<C, I>(
	table: RegistryTable<C>,
	entriesOf: (value: C) => Readonly<Record<string, I>> | undefined,
	report: ComposeContext["report"],
): ReadonlyMap<string, TableItem<I>> {
	const result = new Map<string, TableItem<I>>();
	for (const contribution of table) {
		for (const [key, value] of Object.entries(entriesOf(contribution.value) ?? {})) {
			const first = result.get(key);
			if (first) report({ message: `"${key}" is contributed twice`, plugins: [first.plugin, contribution.plugin] });
			else result.set(key, item(value, contribution.plugin, contribution.type));
		}
	}
	return result;
}
export function orderedEntries<C, I>(
	table: RegistryTable<C>,
	itemsOf: (value: C) => readonly I[] | undefined,
	orderOf?: (item: I) => number,
): readonly TableItem<I>[] {
	const result = table.flatMap((entry) =>
		(itemsOf(entry.value) ?? []).map((value) => item(value, entry.plugin, entry.type)),
	);
	return orderOf ? result.sort((a, b) => orderOf(a.value) - orderOf(b.value)) : result;
}
