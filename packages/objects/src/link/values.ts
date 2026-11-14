import { invalid } from "../data/internal.ts";
import { DeflatedPart, type Part } from "./part.ts";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export function jsonPart(value: unknown): string {
	return JSON.stringify(value) ?? "null";
}
export function payloadPart(
	value: unknown,
	bytes: boolean,
): { readonly json: string; readonly segments: Uint8Array[] | undefined } {
	if (!bytes) return { json: jsonPart(value), segments: undefined };
	const segments: Uint8Array[] = [];
	const json = JSON.stringify(value, function (this: Record<string, unknown>, key: string, value: unknown) {
		if (typeof value !== "object" || value === null) return value;
		const bytes = this[key];
		if (bytes instanceof Uint8Array) {
			segments.push(bytes);
			return { $bytes: segments.length - 1 };
		}
		if (value !== null && typeof value === "object" && Object.hasOwn(value, "$bytes"))
			throw invalid("args", '"$bytes" is reserved in values crossing a link');
		return value;
	});
	return { json: json ?? "null", segments };
}
export function readUtf8(bytes: Uint8Array): string {
	return utf8.decode(bytes);
}
export function parseJson(bytes: Uint8Array): unknown {
	return JSON.parse(readUtf8(bytes));
}
export function parsePart(json: string | Uint8Array): unknown {
	return typeof json === "string" ? JSON.parse(json) : parseJson(json);
}
export function parsePayload(json: string | Uint8Array, segments: readonly Uint8Array[] | undefined): unknown {
	const value = parsePart(json);
	return segments === undefined ? value : resolveSegments(value, segments);
}
export function resolveSegments(value: unknown, segments: readonly Uint8Array[]): unknown {
	if (typeof value !== "object" || value === null) return value;
	if (!Array.isArray(value) && Object.hasOwn(value, "$bytes")) {
		const index: unknown = Reflect.get(value, "$bytes");
		if (Object.keys(value).length !== 1 || typeof index !== "number" || segments[index] === undefined)
			throw new Error("payload: a malformed byte segment reference");
		return segments[index];
	}
	for (const key of Object.keys(value)) {
		const child: unknown = Reflect.get(value, key);
		const resolved = resolveSegments(child, segments);
		if (resolved !== child)
			Object.defineProperty(value, key, {
				value: resolved,
				writable: true,
				configurable: true,
				enumerable: true,
			});
	}
	return value;
}
export function partText(part: Part): string {
	if (!(part instanceof DeflatedPart)) return `[0,${typeof part === "string" ? part : readUtf8(part)}]`;
	let text = "";
	for (let offset = 0; offset < part.bytes.length; offset += 0x8000)
		text += String.fromCharCode(...part.bytes.subarray(offset, offset + 0x8000));
	return `[1,"${btoa(text)}"]`;
}
export function textPart(value: unknown): Part {
	if (!Array.isArray(value) || value.length !== 2) throw new Error("text: a part is no [codec, payload] pair");
	if (value[0] === 0) return JSON.stringify(value[1]);
	if (value[0] === 1 && typeof value[1] === "string")
		return new DeflatedPart(Uint8Array.from(atob(value[1]), (char) => char.charCodeAt(0)));
	throw new Error("text: a part of an unknown codec");
}
