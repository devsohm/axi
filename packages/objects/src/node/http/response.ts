import { STATUS_CODES } from "node:http";
import type { JsonValue } from "../../json.ts";
import type { Ctx } from "../../host/index.ts";
import type { AnswerHeaders } from "./headers.ts";
export type HttpResponse = { readonly headers?: Readonly<Record<string, string | readonly string[]>> } & (
	| { readonly kind: "json"; readonly value: JsonValue; readonly status?: number }
	| { readonly kind: "html"; readonly body: string; readonly status?: number }
	| {
			readonly kind: "bytes";
			readonly mime: string;
			readonly size?: number;
			readonly read: (offset: number, length: number, ctx: Ctx) => Promise<Uint8Array>;
			readonly download?: string;
			readonly inline?: true;
			readonly ranges?: boolean;
	  }
	| { readonly kind: "redirect"; readonly to: string; readonly status?: 302 | 303 | 307 }
	| { readonly kind: "error"; readonly status: number; readonly message?: string }
);
export type Answer = {
	readonly status: number;
	readonly headers: AnswerHeaders;
	readonly body: string | ReadableStream<Uint8Array> | null;
};
export class ResponseFailure extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ResponseFailure";
	}
}
type RequestHead = { readonly method: string; header(name: string): string | null };
function whole(status: number, headers: AnswerHeaders, mime: string | undefined, text: string, head: boolean): Answer {
	if (status < 200 || status > 599) throw new RangeError(`response: status ${status}`);
	if ([204, 205, 304].includes(status)) {
		headers.delete("content-type");
		headers.delete("content-length");
		return { status, headers, body: null };
	}
	if (mime && !headers.has("content-type")) headers.set("Content-Type", mime);
	headers.set("Content-Length", String(Buffer.byteLength(text)));
	return { status, headers, body: head || text === "" ? null : text };
}
export function errorAnswer(status: number, headers: AnswerHeaders, message?: string, head = false): Answer {
	return whole(status, headers, "text/plain; charset=utf-8", message ?? STATUS_CODES[status] ?? "", head);
}
export function answerOf(
	response: HttpResponse,
	request: RequestHead,
	headers: AnswerHeaders,
	ctx: Ctx,
	failed: (error: unknown) => void,
): Answer {
	for (const name in response.headers) headers.set(name, response.headers[name]!);
	const head = request.method === "HEAD";
	switch (response.kind) {
		case "json":
			return whole(
				response.status ?? 200,
				headers,
				"application/json; charset=utf-8",
				JSON.stringify(response.value),
				head,
			);
		case "html":
			return whole(response.status ?? 200, headers, "text/html; charset=utf-8", response.body, head);
		case "error":
			return errorAnswer(response.status, headers, response.message, head);
		case "redirect":
			headers.set("Location", response.to);
			return whole(response.status ?? 302, headers, undefined, "", head);
		case "bytes":
			return bytes(response, request, headers, ctx, failed);
	}
}
export function webResponse(answer: Answer): Response {
	const headers = new Headers();
	for (const [name, value] of answer.headers.lines()) headers.append(name, value);
	return new Response(answer.body as ConstructorParameters<typeof Response>[0], { status: answer.status, headers });
}
function selectRange(
	text: string | null,
	size: number,
): { start: number; length: number } | "unsatisfiable" | undefined {
	const match = text === null ? null : /^bytes=(\d*)-(\d*)$/.exec(text.trim());
	if (!match || (!match[1] && !match[2])) return;
	if (!match[1]) {
		const count = Number(match[2]);
		if (!count || !size) return "unsatisfiable";
		const length = Math.min(count, size);
		return { start: size - length, length };
	}
	const start = Number(match[1]);
	if (start >= size) return "unsatisfiable";
	const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
	return end < start ? undefined : { start, length: end - start + 1 };
}
function disposition(response: { readonly inline?: true; readonly download?: string }): string {
	const mode = response.inline ? "inline" : "attachment";
	if (response.download === undefined) return mode;
	const value = response.download.replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
	const ascii = value.replace(/[^\x20-\x7e]|["\\]/g, "_");
	const encoded = encodeURIComponent(value).replace(
		/['()*]/g,
		(char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
	);
	return `${mode}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
function bytes(
	response: Extract<HttpResponse, { kind: "bytes" }>,
	request: RequestHead,
	headers: AnswerHeaders,
	ctx: Ctx,
	failed: (error: unknown) => void,
): Answer {
	if (!headers.has("content-type")) headers.set("Content-Type", response.mime);
	headers.set("Content-Disposition", disposition(response));
	if (response.inline)
		headers.set("Content-Security-Policy", `${headers.get("content-security-policy") ?? ""}; sandbox`);
	let offset = 0,
		length = response.size,
		status = 200;
	if (response.size !== undefined && response.ranges) {
		headers.set("Accept-Ranges", "bytes");
		const range = selectRange(request.header("range"), response.size);
		if (range === "unsatisfiable") {
			headers.set("Content-Range", `bytes */${response.size}`);
			return whole(416, headers, undefined, "", true);
		}
		if (range) {
			offset = range.start;
			length = range.length;
			status = 206;
			headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${response.size}`);
		}
	}
	if (length !== undefined) headers.set("Content-Length", String(length));
	if (request.method === "HEAD" || length === 0) return { status, headers, body: null };
	const until = length === undefined ? Infinity : offset + length,
		signal = ctx.abortSignal;
	let abort: (() => void) | undefined;
	const detach = (): void => {
		if (abort) signal?.removeEventListener("abort", abort);
	};
	const stream = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				if (!signal) return;
				if (signal.aborted) {
					controller.error(signal.reason);
					return;
				}
				abort = () => controller.error(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
			},
			async pull(controller) {
				if (signal?.aborted) {
					controller.error(signal.reason);
					return;
				}
				const wanted = Math.min(256 * 1024, until - offset);
				let chunk: Uint8Array;
				try {
					chunk = await response.read(offset, wanted, ctx);
					if (length !== undefined && chunk.byteLength !== wanted)
						throw new ResponseFailure(
							`bytes: read ${chunk.byteLength} of ${wanted} bytes at ${offset} (size ${response.size})`,
						);
				} catch (error) {
					if (!signal?.aborted) {
						failed(error);
						controller.error(error);
					}
					return;
				}
				if (signal?.aborted) return;
				if (chunk.byteLength) {
					controller.enqueue(chunk);
					offset += chunk.byteLength;
				}
				if (!chunk.byteLength || offset >= until) {
					detach();
					controller.close();
				}
			},
			cancel: detach,
		},
		{ highWaterMark: 0 },
	);
	return { status, headers, body: stream };
}
