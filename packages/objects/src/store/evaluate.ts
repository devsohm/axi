import type { JsonValue } from "../json.ts";
import { invalid } from "../data/internal.ts";
import type { ExprNode, SetNode, WhereNode } from "./expression.ts";
import type { Scalar } from "./rows.ts";
import { compareText } from "./text.ts";

export type EvaluatedRow = {
	readonly [column: string]: Scalar | JsonValue | undefined;
};
type Truth = boolean | null;
export function compareScalar(a: Scalar, b: Scalar): number {
	return typeof a === "string"
		? compareText(a, b as string)
		: Number(a) - Number(b);
}
export function matches(node: WhereNode, row: EvaluatedRow): boolean {
	return truth(node, row) === true;
}
function truth(node: WhereNode, row: EvaluatedRow): Truth {
	if ("and" in node || "or" in node) {
		const conjunction = "and" in node,
			parts = conjunction ? node.and : node.or;
		let unknown = false;
		for (const part of parts) {
			const value = truth(part, row);
			if (value === !conjunction) return !conjunction;
			if (value === null) unknown = true;
		}
		return unknown ? null : conjunction;
	}
	if ("not" in node) {
		const result = truth(node.not, row);
		return result === null ? null : !result;
	}
	if ("isNull" in node) return row[node.isNull] === undefined;
	if ("inArray" in node) {
		const [name, values] = node.inArray,
			cell = row[name] as Scalar | undefined;
		return !values.length
			? false
			: cell === undefined
				? null
				: values.some((value) => compareScalar(cell, value) === 0);
	}
	if ("prefix" in node) {
		const cell = row[node.prefix[0]] as string | undefined;
		return cell === undefined ? null : cell.startsWith(node.prefix[1]);
	}
	const compare = (
		pair: readonly [string, Scalar],
		accept: (order: number) => boolean,
	): Truth => {
		const value = row[pair[0]] as Scalar | undefined;
		return value === undefined ? null : accept(compareScalar(value, pair[1]));
	};
	if ("eq" in node) return compare(node.eq, (order) => order === 0);
	if ("ne" in node) return compare(node.ne, (order) => order !== 0);
	if ("lt" in node) return compare(node.lt, (order) => order < 0);
	if ("lte" in node) return compare(node.lte, (order) => order <= 0);
	if ("gt" in node) return compare(node.gt, (order) => order > 0);
	return compare(node.gte, (order) => order >= 0);
}
export function applySet(
	set: SetNode,
	row: EvaluatedRow,
	table: string,
): EvaluatedRow {
	const result = { ...row };
	for (const name of Object.keys(set)) {
		const value = evaluate(set[name]!, row, table);
		if (value === undefined) delete result[name];
		else result[name] = value;
	}
	return result;
}
function evaluate(
	node: ExprNode,
	row: EvaluatedRow,
	table: string,
): Scalar | JsonValue | undefined {
	if (node === null) return undefined;
	if (typeof node !== "object") return node;
	if ("col" in node) return row[node.col];
	if ("json" in node) return node.json;
	if ("coalesce" in node)
		return (
			evaluate(node.coalesce[0], row, table) ??
			evaluate(node.coalesce[1], row, table)
		);
	if ("when" in node)
		return evaluate(node.when[matches(node.when[0], row) ? 1 : 2], row, table);
	if ("replacePrefix" in node) {
		const [subject, from, to] = node.replacePrefix,
			value = evaluate(subject, row, table) as string | undefined;
		return value === undefined || !value.startsWith(from)
			? value
			: to + value.substring(from.length);
	}
	const pair =
		"add" in node
			? node.add
			: "sub" in node
				? node.sub
				: "concat" in node
					? node.concat
					: "max" in node
						? node.max
						: node.min;
	const left = evaluate(pair[0], row, table) as Scalar | undefined,
		right = evaluate(pair[1], row, table) as Scalar | undefined;
	if (left === undefined || right === undefined) return undefined;
	if ("concat" in node) return String(left) + String(right);
	if ("max" in node) return compareScalar(left, right) < 0 ? right : left;
	if ("min" in node) return compareScalar(left, right) > 0 ? right : left;
	const result =
		"add" in node ? Number(left) + Number(right) : Number(left) - Number(right);
	if (Math.abs(result) > Number.MAX_SAFE_INTEGER)
		throw invalid(
			"args",
			`${table}: ${"add" in node ? "add" : "sub"} gives ${result}, outside ±(2^53 - 1)`,
		);
	return result;
}
