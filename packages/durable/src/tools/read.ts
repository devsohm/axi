import type { Context } from "@axi/chord";
import { characterEnd } from "@axi/chord/output";
import { type Static, Type } from "typebox";
import { type BinaryReader, type FileInfo, getOrThrow, rangeDecoder, startsWithBom } from "../env/index.ts";
import { defineTool } from "../harness/define.ts";
import type { ToolDiagnostic, ToolExecutionApi, ToolExecutionResult } from "../harness/types.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHeadOf,
	utf8ByteLength,
} from "../truncate.ts";
import { requireEnv } from "./env.ts";
import { detectSupportedImageMimeTypeOf, imageDimensions } from "./image.ts";
import {
	base64Length,
	DEFAULT_IMAGE_LIMITS,
	type ImageLimits,
	type ImageProcessor,
	INLINE_IMAGE_TYPES,
	toBase64,
} from "./image-processor.ts";
import { resolveReadToolPath } from "./path-utils.ts";

const parameters = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});
export type ReadToolInput = Static<typeof parameters>;
export type ReadToolDetails = { truncation?: Omit<TruncationResult, "content"> };
export type ReadToolOptions = { readonly images?: ImageProcessor };
const integer = (value: number): number => (Number.isNaN(value) ? 0 : Math.trunc(value));

async function prefix(
	reader: BinaryReader,
	start: number,
	end: number,
	skipBom: boolean,
	context: Context,
): Promise<string> {
	const decoder = rangeDecoder();
	let text = "";
	let lines = 0;
	for (let cursor = skipBom && start === 0 ? 3 : start; cursor < end; ) {
		const bytes = getOrThrow(await reader.read(cursor, Math.min(65536, end - cursor), context));
		if (!bytes.length) break;
		cursor += bytes.length;
		const chunk = decoder.decode(bytes, { stream: true });
		text += chunk;
		lines += chunk.split("\n").length - 1;
		if (lines >= DEFAULT_MAX_LINES || utf8ByteLength(text) > DEFAULT_MAX_BYTES + 1) return text;
	}
	return text + decoder.decode();
}

async function readText(
	reader: BinaryReader,
	{ path, offset, limit }: ReadToolInput,
	context: Context,
): Promise<ToolExecutionResult<ReadToolDetails>> {
	const start = offset ? Math.max(0, offset - 1) : 0;
	const sliceStart = integer(start);
	const scanStart = Number.isSafeInteger(sliceStart) ? sliceStart : 0;
	const requestedEnd = limit === undefined ? undefined : Math.max(scanStart + 1, integer(start + limit));
	const scanEnd = requestedEnd !== undefined && Number.isSafeInteger(requestedEnd) ? requestedEnd : undefined;
	const scanTo = async (endLine?: number) =>
		getOrThrow(
			await reader.scanLines({ startLine: scanStart, ...(endLine === undefined ? {} : { endLine }) }, context),
		);
	let scan = await scanTo(scanEnd);
	const count = scan.newlines + 1;
	if (start >= count) throw new Error(`Offset ${offset} is beyond end of file (${count} lines total)`);
	let userLimit: number | undefined;
	let selected = count - sliceStart;
	if (limit !== undefined) {
		const end = Math.min(start + limit, count);
		userLimit = end - start;
		const relative = integer(end);
		const sliceEnd = relative < 0 ? Math.max(count + relative, 0) : relative;
		selected = Math.max(0, sliceEnd - sliceStart);
		if (selected > 0 && relative < 0) scan = await scanTo(sliceEnd);
	}
	const empty = selected === 0;
	const trailingNewline = !empty && scan.lastLineStart === scan.end && scan.lastLineStart > scan.start;
	const totals = {
		lines: empty || scan.selectedBytes === 0 ? 0 : selected - (trailingNewline ? 1 : 0),
		bytes: empty ? 0 : scan.selectedBytes,
	};
	const skipBom = startsWithBom(getOrThrow(await reader.read(0, 3, context)));
	const head = empty ? "" : await prefix(reader, scan.start, scan.end, skipBom, context);
	const { content, ...truncation } = truncateHeadOf(head, totals);
	const diagnostics: ToolDiagnostic[] = [];
	let text = content;
	let details: ReadToolDetails | undefined;
	const displayStart = start + 1;
	if (truncation.firstLineExceedsLimit) {
		const integral = Number.isInteger(start);
		const first = new TextEncoder().encode(integral ? (head.split("\n")[0] ?? "") : "");
		const end = characterEnd(first, DEFAULT_MAX_BYTES);
		text = new TextDecoder().decode(first.subarray(0, end));
		details = { truncation: { ...truncation, outputBytes: end, outputLines: 1 } };
		diagnostics.push({
			severity: "warn",
			code: "truncated",
			message: `Line ${displayStart} is ${formatSize(integral ? scan.firstLineBytes : 0)}, exceeds the ${formatSize(DEFAULT_MAX_BYTES)} limit; showing its first ${formatSize(end)}. Use bash: sed -n '${displayStart}p' ${path} | tail -c +${end + 1}`,
		});
	} else if (truncation.truncated) {
		const last = displayStart + truncation.outputLines - 1;
		details = { truncation };
		diagnostics.push({
			severity: "info",
			code: "truncated",
			message: `Showing lines ${displayStart}-${last} of ${count}${truncation.truncatedBy === "lines" ? "" : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`}. Use offset=${last + 1} to continue.`,
		});
	} else if (userLimit !== undefined && start + userLimit < count) {
		diagnostics.push({
			severity: "info",
			message: `${count - start - userLimit} more lines in file. Use offset=${start + userLimit + 1} to continue.`,
		});
	}
	return {
		output: text === "" ? [] : [{ type: "text", text }],
		...(details === undefined ? {} : { details }),
		diagnostics,
	};
}

async function readImage(
	reader: BinaryReader,
	info: FileInfo,
	path: string,
	mimeType: string,
	processor: ImageProcessor | undefined,
	api: ToolExecutionApi,
	context: Context,
): Promise<ToolExecutionResult<ReadToolDetails>> {
	const ref = (await api.agent(context)).model;
	const model = ref === undefined ? undefined : api.models.getModel(ref.provider, ref.modelId);
	const vision = model?.input.includes("image") ?? true;
	const resize = model?.inputLimits?.images?.resize;
	const limits: ImageLimits = {
		maxWidth: resize?.maxWidth ?? DEFAULT_IMAGE_LIMITS.maxWidth,
		maxHeight: resize?.maxHeight ?? DEFAULT_IMAGE_LIMITS.maxHeight,
		maxBytes: resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes,
	};
	const reject = (message: string): ToolExecutionResult<ReadToolDetails> => ({
		output: [],
		isError: true,
		diagnostics: [{ severity: "error", code: "unsupported_image", message }],
	});
	const notes: string[] = [];
	let image: { data: string; mimeType: string };
	if (processor !== undefined) {
		const prepared = await processor.prepare(getOrThrow(await reader.read(0, info.size, context)), mimeType, limits);
		if (prepared === undefined)
			return reject(`${path} is an image (${mimeType}) that cannot be prepared for the model`);
		image = prepared;
		if (prepared.convertedFrom !== undefined)
			notes.push(`Converted from ${prepared.convertedFrom} to ${prepared.mimeType}.`);
		if (prepared.resized !== undefined) {
			const { from, to } = prepared.resized;
			notes.push(
				`Resized from ${from.width}x${from.height} to ${to.width}x${to.height}. Multiply coordinates by ${(from.width / to.width).toFixed(2)} to map them to the original.`,
			);
		}
	} else {
		if (!INLINE_IMAGE_TYPES.has(mimeType))
			return reject(`${path} is an image (${mimeType}) that needs converting, and no image processor is configured`);
		if (base64Length(info.size) > limits.maxBytes)
			return reject(
				`${path} is an image (${mimeType}) of ${formatSize(info.size)}, too large to send, and no image processor is configured to shrink it`,
			);
		const bytes = getOrThrow(await reader.read(0, info.size, context));
		const dimensions = imageDimensions(bytes, mimeType);
		if (dimensions === undefined) return reject(`${path} is an image (${mimeType}) whose size cannot be read`);
		if (dimensions.width > limits.maxWidth || dimensions.height > limits.maxHeight)
			return reject(
				`${path} is an image (${mimeType}) of ${dimensions.width}x${dimensions.height}, larger than ${limits.maxWidth}x${limits.maxHeight}, and no image processor is configured to shrink it`,
			);
		image = { data: toBase64(bytes), mimeType };
	}
	if (!vision) notes.push("The current model does not support images; it sees a placeholder instead.");
	return {
		output: [{ type: "image", data: image.data, mimeType: image.mimeType }],
		diagnostics: [
			{ severity: "info", code: "image", message: [`Read image file [${image.mimeType}].`, ...notes].join(" ") },
		],
	};
}

export function createReadTool(options: ReadToolOptions = {}) {
	const formats = options.images === undefined ? "jpg, png, gif, webp" : "jpg, png, gif, webp, bmp";
	return defineTool<typeof parameters, ReadToolDetails>({
		name: "read",
		description: `Read the contents of a file. Supports text files and images (${formats}). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		parameters,
		async execute(args, api, context) {
			const env = requireEnv(api);
			const path = await resolveReadToolPath(env, args.path, context);
			const reader = getOrThrow(await env.openBinaryReader(path, undefined, context));
			try {
				for (let attempt = 0; ; attempt++) {
					const before = getOrThrow(await reader.info(context));
					const mimeType = await detectSupportedImageMimeTypeOf({
						size: before.size,
						read: async (at, length) => getOrThrow(await reader.read(at, length, context)),
					});
					const result =
						mimeType === undefined
							? await readText(reader, args, context)
							: await readImage(reader, before, args.path, mimeType, options.images, api, context);
					const after = getOrThrow(await reader.info(context));
					if (
						(before.size === after.size && before.mtimeMs === after.mtimeMs) ||
						(mimeType === undefined && after.size > before.size)
					)
						return result;
					if (attempt === 1) throw new Error(`${args.path} changed while it was read`);
				}
			} finally {
				await reader.close(context);
			}
		},
	});
}
