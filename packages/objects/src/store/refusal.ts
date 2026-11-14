import { ObjectsError, isObjectsError } from "../data/index.ts";

export type Refusal =
	| { readonly kind: "check"; readonly error: ObjectsError }
	| { readonly kind: "broken"; readonly error: ObjectsError };
export function refusalOf(error: unknown, label: string): Refusal | undefined {
	if (isObjectsError(error, "released") || (isObjectsError(error, "unavailable") && error.reason === "storage_failed"))
		return undefined;
	const message = error instanceof Error ? error.message : String(error);
	const code: unknown = error == null ? undefined : Reflect.get(Object(error), "errcode");
	const range = typeof code === "number" ? code === 275 : message.includes("CHECK constraint failed");
	return range
		? {
				kind: "check",
				error: new ObjectsError(
					{
						code: "invalid",
						reason: "args",
						message: `${label}: a value is out of its column's range (${message})`,
					},
					{ cause: error },
				),
			}
		: {
				kind: "broken",
				error: new ObjectsError(
					{
						code: "unavailable",
						message: `${label}: the store refused the commit (${message})`,
					},
					{ cause: error },
				),
			};
}
