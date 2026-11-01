import type { Id, Seq } from "./types.ts";

export function idFromNumber<RecordId extends Id<string>>(value: number): RecordId {
	return value as RecordId;
}
export function seqFromNumber(value: number): Seq {
	return value as Seq;
}
