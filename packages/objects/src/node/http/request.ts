import type { JsonValue } from "../../json.ts";
import type { Provenance } from "./admission.ts";
import type { Incoming } from "./incoming.ts";

export interface HttpRequest {
	readonly method: string;
	readonly path: string;
	readonly params: Readonly<Record<string, string>>;
	readonly query: URLSearchParams;
	readonly headers: Headers;
	readonly origin: string;
	readonly provenance: Provenance;
	readonly nonce: string;
	readonly remoteAddress: string | undefined;
	json(limit?: number): Promise<JsonValue>;
	body(limit?: number): AsyncIterable<Uint8Array>;
}
export class HttpFailure extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "HttpFailure";
		this.status = status;
	}
}
export class WebRequest implements HttpRequest {
	readonly method: string;
	readonly path: string;
	readonly origin: string;
	readonly provenance: Provenance;
	readonly nonce: string;
	readonly remoteAddress: string | undefined;
	params: Readonly<Record<string, string>> = {};
	readonly #input: Incoming;
	readonly #search: string;
	#query: URLSearchParams | undefined;
	#consumed = false;
	constructor(
		input: Incoming,
		admission: { readonly origin: string; readonly provenance: Provenance },
		nonce: string,
		remoteAddress?: string,
	) {
		this.#input = input;
		this.method = input.method;
		const url = splitUrl(input.url);
		this.path = url.path;
		this.#search = url.search;
		this.origin = admission.origin;
		this.provenance = admission.provenance;
		this.nonce = nonce;
		this.remoteAddress = remoteAddress;
	}
	get headers(): Headers {
		return this.#input.request().headers;
	}
	get query(): URLSearchParams {
		return (this.#query ??= new URLSearchParams(this.#search));
	}
	async json(limit = 1024 * 1024): Promise<JsonValue> {
		const chunks: Uint8Array[] = [];
		for await (const chunk of this.body(limit)) chunks.push(chunk);
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonValue;
		} catch {
			throw new HttpFailure(400, "the body is no JSON");
		}
	}
	async *body(limit = 1024 * 1024): AsyncIterable<Uint8Array> {
		if (this.#consumed) throw new Error("request body: read twice");
		this.#consumed = true;
		if (Number(this.#input.header("content-length") ?? Number.NaN) > limit)
			throw new HttpFailure(413, `the body is larger than ${limit} bytes`);
		const stream = this.#input.request().body;
		if (!stream) return;
		const reader = stream.getReader();
		let size = 0;
		try {
			while (true) {
				let part: Awaited<ReturnType<typeof reader.read>>;
				try {
					part = await reader.read();
				} catch {
					throw new HttpFailure(400, "the body could not be read whole");
				}
				if (part.done) break;
				size += part.value.byteLength;
				if (size > limit) throw new HttpFailure(413, `the body is larger than ${limit} bytes`);
				yield part.value;
			}
		} finally {
			reader.releaseLock();
		}
	}
}
export function splitUrl(text: string): { readonly path: string; readonly search: string } {
	const start = text.indexOf("//") + 2;
	const end = text.indexOf("#", start);
	const visible = end < 0 ? text : text.slice(0, end);
	const query = visible.indexOf("?", start);
	const slash = visible.indexOf("/", start);
	return {
		path: slash < 0 || (query >= 0 && slash > query) ? "/" : visible.slice(slash, query < 0 ? undefined : query),
		search: query < 0 ? "" : visible.slice(query + 1),
	};
}
