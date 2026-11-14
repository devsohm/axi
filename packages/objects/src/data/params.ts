import type { Context } from "../context/index.ts";
import { contractData, type Contract, type ParamsOf, type ShapeOf } from "../contracts/contract.ts";
import { addressKey, type Address } from "../contracts/host-kind.ts";
import { joinKey, type ParamsData } from "../contracts/params.ts";
import { check, validatorFor } from "./validator.ts";

export function checkParams<C extends Contract>(
	contract: C,
	raw: unknown,
	context: Context,
): { readonly params: ParamsOf<C>; readonly key: string } {
	const data = contractData(contract).params;
	check(validatorFor(data, context), raw, "params", context);
	const values = raw as Record<string, string | number | boolean> & ParamsOf<C>;
	return { params: values, key: joinKey(data.fields.map((field) => String(values[field]))) };
}
export function identityKey<C extends Contract>(
	contract: C,
	key: string,
	...principal: ShapeOf<C>["kind"] extends "local" ? [] : [principalKey: string]
): string {
	return joinKey([contract.name, key, ...principal]);
}
export function checkAddress(kind: string, params: ParamsData, raw: unknown, context: Context): Address {
	check(validatorFor(params, context), raw, "host_address", context);
	const values = raw as Record<string, string | number | boolean>;
	return { kind, params: values, key: addressKey(kind, params, values) };
}
