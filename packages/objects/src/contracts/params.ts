import type { TBoolean, TInteger, TLiteral, TString, TUnion } from "typebox";
import type { JsonValue } from "../json.ts";
import type { TSchema } from "./schema.ts";
import { snapshotSchema } from "./snapshot.ts";

export type Params = Readonly<Record<string, TString | TInteger | TBoolean | TUnion<TLiteral<string>[]>>>;
export type RequiredFields<P extends Params> = { [K in keyof P]: P[K] extends { readonly "~optional": true } ? never : P[K] };
export type ParamsData = { readonly fields: readonly string[]; readonly schema: TSchema; readonly normal: JsonValue };
function allowed(value: JsonValue): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (Object.hasOwn(value, "anyOf")) return Object.keys(value).length === 1 && Array.isArray(value.anyOf) && value.anyOf.every((branch) =>
		branch !== null && typeof branch === "object" && !Array.isArray(branch) && branch.type === "string" && typeof branch.const === "string" && Object.keys(branch).length === 2);
	const keywords = value.type === "string" ? ["type", "minLength", "maxLength", "pattern", "format"]
		: value.type === "integer" ? ["type", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]
		: value.type === "boolean" ? ["type"] : [];
	return keywords.length > 0 && Object.keys(value).every((key) => keywords.includes(key));
}
export function readParams(fields: readonly [string, unknown][], path: string): ParamsData {
	const schemas = fields.map(([name, schema]) => {
		const at = `${path}.${name}`, snap = snapshotSchema(schema, at);
		if (Object.hasOwn(schema as object, "~optional") || !allowed(snap.normal))
			throw new Error(`${at}: a param is a required str(), int(), bool() or oneOf(...) of strings`);
		return [name, snap] as const;
	});
	const names = schemas.map(([name]) => name);
	return { fields: names, schema: { type: "object", additionalProperties: false, required: names,
		properties: Object.fromEntries(schemas.map(([name, schema]) => [name, schema.schema])) },
		normal: schemas.map(([name, schema]) => [name, schema.normal]) };
}
export const joinKey = (parts: readonly string[]): string => parts.map((part) => part.replace(/[\\|]/g, "\\$&")).join("|");
