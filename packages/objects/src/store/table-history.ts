import type { TableRecord } from "./catalog.ts";
import type { ColumnRecord } from "./columns.ts";
import type { SetNode, WhereNode } from "./expression.ts";
import type { TableDefinition } from "./table.ts";

export type TableEdit =
	| { readonly kind: "rename"; readonly from: string; readonly to: string }
	| {
			readonly kind: "add";
			readonly name: string;
			readonly column: ColumnRecord;
	  }
	| {
			readonly kind: "json";
			readonly name: string;
			readonly column: ColumnRecord;
	  }
	| { readonly kind: "drop"; readonly name: string }
	| { readonly kind: "dropIndex"; readonly name: string }
	| {
			readonly kind: "index";
			readonly name: string;
			readonly columns: readonly string[];
	  };
export type AlterEdit = Extract<
	TableEdit,
	{ readonly kind: "rename" | "add" | "drop" | "json" }
>;
export type DataStep =
	| {
			readonly kind: "rows";
			readonly table: TableDefinition;
			readonly patch: (row: Readonly<Record<string, unknown>>) => unknown;
	  }
	| {
			readonly kind: "update";
			readonly table: TableDefinition;
			readonly where: WhereNode | undefined;
			readonly set: SetNode;
	  };
export type Migration = {
	readonly before: readonly TableEdit[];
	readonly step: DataStep | undefined;
	readonly after: readonly TableEdit[];
};
export type TablePlan =
	| { readonly kind: "create" | "ready" }
	| {
			readonly kind: "migrate";
			readonly versions: readonly TableDefinition[];
			readonly first: "begin" | "resume";
	  };
export function planTable(
	definition: TableDefinition,
	recorded: TableRecord | undefined,
	what: string,
): TablePlan {
	if (!recorded) return { kind: "create" };
	if (recorded.version > definition.version)
		throw new Error(
			`${what}: the store has version ${recorded.version}, newer than the code's ${definition.version}`,
		);
	const versions = historyOf(definition);
	const found = versions.find(
		(version) => version.version === recorded.version,
	);
	if (!found)
		throw new Error(
			`${what}: the store has version ${recorded.version}, older than the history's base ${versions[0]!.version}`,
		);
	if (found.fingerprint !== recorded.fingerprint)
		throw new Error(
			`${what}: version ${recorded.version} is recorded with another definition (a history edited in place)`,
		);
	if (recorded.state === "ready" && recorded.version === definition.version)
		return { kind: "ready" };
	const resuming = recorded.state === "migrating";
	if (resuming && !found.evolution?.migration.step)
		throw new Error(
			`${what}: version ${recorded.version} is recorded migrating, but has no data step to resume`,
		);
	return {
		kind: "migrate",
		versions: versions.filter((version) =>
			resuming
				? version.version >= recorded.version
				: version.version > recorded.version,
		),
		first: resuming ? "resume" : "begin",
	};
}
export function historyOf(definition: TableDefinition): TableDefinition[] {
	const versions: TableDefinition[] = [];
	for (let current: TableDefinition | undefined = definition; current; current = current.evolution?.previous)
		versions.push(current);
	return versions.reverse();
}
