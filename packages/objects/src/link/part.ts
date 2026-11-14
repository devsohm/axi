import { objectsMetrics } from "../telemetry.ts";
import type { Context } from "../context/index.ts";
import { ObjectsError } from "../data/errors.ts";

export type Inflated =
	| { readonly kind: "bytes"; readonly bytes: Uint8Array }
	| { readonly kind: "too_large" }
	| { readonly kind: "corrupt"; readonly error: unknown };
export interface Compression {
	deflate(bytes: Uint8Array): Uint8Array;
	inflate(bytes: Uint8Array, limit: number): Inflated;
}
export class DeflatedPart {
	inflated: Inflated | undefined;
	readonly bytes: Uint8Array;
	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
	}
}
export type Part = string | Uint8Array | DeflatedPart;
export type PartLimits = { readonly part?: number; readonly decoded?: number };
export type Limits = { readonly part: number; readonly decoded: number };
export const COMPRESS_ABOVE = 16384;
const utf8 = new TextEncoder();
export function linkLimits(trusted: boolean, limits: PartLimits = {}): Limits {
	return {
		part: limits.part ?? (trusted ? Infinity : 16777216),
		decoded: limits.decoded ?? (trusted ? Infinity : 67108864),
	};
}
function byteLength(value: Part): number {
	if (typeof value !== "string") return value instanceof DeflatedPart ? value.bytes.byteLength : value.byteLength;
	let count = 0;
	for (const character of value) {
		const point = character.codePointAt(0)!;
		count += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
	}
	return count;
}
function overflow(size: number | undefined, limit: number, measure: "wire" | "decoded"): ObjectsError {
	return new ObjectsError({
		code: "too_large",
		reason: "part",
		message: `a part${size === undefined ? "" : ` of ${size} bytes`} is over the ${measure} limit of ${limit} bytes`,
	});
}
export function oversized(part: Part, limit: number): ObjectsError | undefined {
	if (limit === Infinity) return undefined;
	const size = byteLength(part);
	return size > limit ? overflow(size, limit, "wire") : undefined;
}
export function originPart(json: string, compression: Compression | undefined, context: Context): Part {
	if (!compression || json.length <= COMPRESS_ABOVE / 3) return json;
	const bytes = utf8.encode(json);
	if (bytes.byteLength <= COMPRESS_ABOVE) return bytes;
	objectsMetrics(context.telemetry.metrics).counter("objects.link.deflates").add(1);
	const compressed = compression.deflate(bytes);
	return compressed.byteLength < bytes.byteLength ? new DeflatedPart(compressed) : bytes;
}
export function openPart(
	part: Part,
	limits: Limits,
	compression: Compression | undefined,
	context: Context,
): string | Uint8Array {
	const error = oversized(part, limits.part);
	if (error) throw error;
	if (!(part instanceof DeflatedPart)) {
		if (limits.decoded !== Infinity) {
			const size = byteLength(part);
			if (size > limits.decoded) throw overflow(size, limits.decoded, "decoded");
		}
		return part;
	}
	let result = part.inflated;
	if (!result) {
		if (!compression) throw new Error("part: a deflated part this host did not inflate");
		objectsMetrics(context.telemetry.metrics).counter("objects.link.inflates").add(1);
		result = compression.inflate(part.bytes, limits.decoded);
	}
	if (result.kind === "bytes") return result.bytes;
	if (result.kind === "too_large") throw overflow(undefined, limits.decoded, "decoded");
	throw new Error("part: no raw deflate stream", { cause: result.error });
}
export async function inflateAsync(
	part: DeflatedPart,
	limit: number,
	signal: AbortSignal,
	context: Context,
): Promise<void> {
	objectsMetrics(context.telemetry.metrics).counter("objects.link.inflates").add(1);
	const reader = new Blob([part.bytes as Uint8Array<ArrayBuffer>])
		.stream()
		.pipeThrough(new DecompressionStream("deflate-raw"))
		.getReader();
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	const pieces: Uint8Array[] = [];
	let length = 0;
	signal.addEventListener("abort", cancel, { once: true });
	try {
		while (!signal.aborted) {
			const read = await reader.read();
			if (read.done || signal.aborted) break;
			length += read.value.byteLength;
			if (length > limit) {
				part.inflated = { kind: "too_large" };
				cancel();
				return;
			}
			pieces.push(read.value);
		}
	} catch (error) {
		if (!signal.aborted) part.inflated = { kind: "corrupt", error };
		return;
	} finally {
		signal.removeEventListener("abort", cancel);
		if (signal.aborted) cancel();
	}
	if (signal.aborted) return;
	const bytes = new Uint8Array(length);
	let position = 0;
	for (const piece of pieces) {
		bytes.set(piece, position);
		position += piece.byteLength;
	}
	part.inflated = { kind: "bytes", bytes };
}
