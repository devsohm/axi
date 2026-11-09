import { StorageRequestError } from "../errors.ts";
import type { Cursor, ScanOrder } from "../types.ts";

export function scanPosition(
	requested: ScanOrder | undefined,
	cursor: Cursor | undefined,
	fallback: ScanOrder,
): { order: ScanOrder; after: number | undefined } {
	if (requested !== undefined && requested !== "ascending" && requested !== "descending")
		throw new StorageRequestError(`Invalid scan order: ${String(requested)}`);
	if (cursor === undefined) return { order: requested ?? fallback, after: undefined };
	const { after, order: stored } = cursor;
	if (
		typeof after !== "number" ||
		!Number.isSafeInteger(after) ||
		(stored !== undefined && stored !== "ascending" && stored !== "descending")
	)
		throw new StorageRequestError("Invalid storage cursor");
	const order = stored ?? fallback;
	if (requested !== undefined && requested !== order)
		throw new StorageRequestError(`The cursor continues a ${order} scan; the query asks for ${requested}`);
	return { order, after };
}
