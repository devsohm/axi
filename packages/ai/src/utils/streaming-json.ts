import type { JsonValue, ToolCall } from "../types.ts";
import { parseToolCallArguments } from "./json-parse.ts";

export type JsonPath = readonly (string | number)[];
export type JsonChange =
	| { readonly kind: "set"; readonly path: JsonPath; readonly value: JsonValue }
	| { readonly kind: "append"; readonly path: JsonPath; readonly text: string };
type Change = { kind: "set"; path: JsonPath; value: JsonValue } | { kind: "append"; path: JsonPath; text: string };
type Container = JsonValue[] | Record<string, JsonValue>;
type Location = { kind: "root" } | { kind: "field"; key: string } | { kind: "item"; key: number };
type Level = {
	data: Container;
	location: Location | undefined;
	path: JsonPath | undefined;
	key: string | undefined;
	phase: "key" | "colon" | "value" | "next";
	size: number;
};
type StringToken = { kind: "string"; key: boolean; text: string; escape: string; location: Location | undefined; path: JsonPath | undefined; change: Change | undefined };
type Token = StringToken | { kind: "scalar"; text: string; location: Location | undefined };
const ESCAPES: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const EXPONENT = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?)[eE][+-]?$/;
const LITERALS = [["true", true], ["false", false], ["null", null]] as const;
const DELIMITERS = ' \t\n\r,:{}[]"';

export class StreamingJsonParser {
	readonly #levels: Level[] = [];
	#root: JsonValue | undefined;
	#token: Token | undefined;
	#finished = false;
	#changes: Change[] = [];
	#copyCost = 0;
	#credit = 0;
	#dirty = false;
	#snapshot: JsonValue | undefined;
	append(text: string): readonly JsonChange[] {
		this.#credit += 256 + text.length * 8;
		this.#changes = [];
		if (this.#token?.kind === "string") this.#token.change = undefined;
		let index = 0;
		while (index < text.length && !this.#finished) {
			if (this.#token?.kind === "string") index = this.#readString(this.#token, text, index);
			else if (this.#token?.kind === "scalar") {
				const token = this.#token;
				const start = index;
				while (index < text.length && !DELIMITERS.includes(text[index]!)) index++;
				if (index > start) { token.text += text.slice(start, index); if (token.location !== undefined) this.#dirty = true; }
				if (index < text.length) {
					this.#token = undefined;
					const value = scalar(token.text, false);
					if (value !== undefined) {
						this.#put(token.location, value);
						const path = this.#path(token.location);
						if (path !== undefined) this.#changes.push({ kind: "set", path, value });
					}
					this.#completed();
				}
			} else this.#readPunctuation(text[index++]!);
		}
		return this.#changes;
	}
	snapshot(): JsonValue | undefined {
		if (!this.#dirty) return this.#snapshot;
		const token = this.#token;
		const pending = token?.kind === "scalar" && token.location !== undefined && token.text.length <= 64 ? scalar(token.text, true) : undefined;
		const cost = this.#copyCost + (pending === undefined ? 0 : 1);
		if (cost > this.#credit) return this.#snapshot;
		this.#credit -= cost;
		this.#dirty = false;
		if (this.#levels.length === 0) this.#snapshot = pending !== undefined && token?.location?.kind === "root" ? pending : this.#root;
		else {
			let child: JsonValue | undefined;
			let location: Location | undefined;
			for (let index = this.#levels.length - 1; index >= 0; index--) {
				const level = this.#levels[index]!;
				const copy = Array.isArray(level.data) ? level.data.slice() : { ...level.data };
				if (index === this.#levels.length - 1 && pending !== undefined) put(copy, token!.location!, pending);
				if (child !== undefined && location !== undefined) put(copy, location, child);
				child = copy;
				location = level.location;
			}
			this.#snapshot = location?.kind === "root" ? child : this.#root;
		}
		return this.#snapshot;
	}
	#location(): Location | undefined {
		const parent = this.#levels.at(-1);
		if (parent === undefined) return this.#root === undefined ? { kind: "root" } : undefined;
		if (Array.isArray(parent.data)) return { kind: "item", key: parent.data.length };
		return parent.key !== undefined && (parent.phase === "value" || parent.phase === "colon") ? { kind: "field", key: parent.key } : undefined;
	}
	#path(location: Location | undefined): JsonPath | undefined {
		if (location === undefined) return undefined;
		if (location.kind === "root") return [];
		const parent = this.#levels.at(-1)!;
		return parent.path !== undefined && parent.path.length < 32 ? [...parent.path, location.key] : undefined;
	}
	#readPunctuation(char: string): void {
		const parent = this.#levels.at(-1);
		if (' \t\n\r'.includes(char)) return;
		if (char === '"') {
			const key = parent !== undefined && !Array.isArray(parent.data) && (parent.phase === "key" || parent.phase === "next");
			const location = key ? undefined : this.#location();
			const path = key ? undefined : this.#path(location);
			const token: StringToken = { kind: "string", key, text: "", escape: "", location, path, change: undefined };
			this.#token = token;
			if (!key) {
				this.#put(location, "");
				if (path !== undefined) { token.change = { kind: "set", path, value: "" }; this.#changes.push(token.change); }
			}
		} else if (char === "{" || char === "[") {
			const location = this.#location();
			const path = this.#path(location);
			const data = char === "[" ? [] : {};
			this.#put(location, data);
			this.#levels.push({ data, location, path, key: undefined, phase: char === "[" ? "value" : "key", size: 0 });
			this.#copyCost++;
			this.#dirty = true;
			if (path !== undefined) this.#changes.push({ kind: "set", path, value: char === "[" ? [] : {} });
		} else if (char === "}" || char === "]") {
			const level = this.#levels.pop();
			if (level === undefined) return;
			this.#copyCost -= level.size + 1;
			this.#dirty = true;
			if (level.path?.length === 32) this.#changes.push({ kind: "set", path: level.path, value: level.data });
			this.#completed();
		} else if (char === ":") {
			if (parent !== undefined && !Array.isArray(parent.data) && parent.phase === "colon") parent.phase = "value";
		} else if (char === ",") {
			if (parent !== undefined) parent.phase = Array.isArray(parent.data) ? "value" : "key";
		} else {
			const location = this.#location();
			this.#token = { kind: "scalar", text: char, location };
			if (location !== undefined) this.#dirty = true;
		}
	}
	#completed(): void {
		const parent = this.#levels.at(-1);
		if (parent !== undefined) parent.phase = "next";
		else if (this.#root !== undefined) this.#finished = true;
	}
	#put(location: Location | undefined, value: JsonValue): void {
		if (location === undefined) return;
		this.#dirty = true;
		if (location.kind === "root") { this.#root = value; return; }
		const parent = this.#levels.at(-1)!;
		if (!Object.hasOwn(parent.data, location.key)) { parent.size++; this.#copyCost++; }
		put(parent.data, location, value);
	}
	#readString(token: StringToken, text: string, start: number): number {
		let run = start;
		for (let index = start; index < text.length; index++) {
			const char = text[index]!;
			if (token.escape !== "") {
				let decoded: string | undefined;
				let consumed = true;
				if (token.escape === "\\") {
					if (Object.hasOwn(ESCAPES, char)) { decoded = ESCAPES[char]!; token.escape = ""; }
					else if (char === "u") token.escape += char;
					else { decoded = token.escape; token.escape = ""; consumed = false; }
				} else if (/^[0-9a-f]$/i.test(char)) {
					token.escape += char;
					if (token.escape.length === 6) { decoded = String.fromCharCode(Number.parseInt(token.escape.slice(2), 16)); token.escape = ""; }
				} else { decoded = token.escape; token.escape = ""; consumed = false; }
				if (decoded !== undefined) this.#extendString(token, decoded);
				run = consumed ? index + 1 : index;
				if (consumed) continue;
			}
			if (char === '"' || char === "\\") {
				if (index > run) this.#extendString(token, text.slice(run, index));
				if (char === "\\") { token.escape = char; run = index + 1; }
				else {
					this.#token = undefined;
					const parent = this.#levels.at(-1);
					if (token.key && parent !== undefined) { parent.key = token.text; parent.phase = "colon"; }
					else this.#completed();
					return index + 1;
				}
			}
		}
		if (run < text.length) this.#extendString(token, text.slice(run));
		return text.length;
	}
	#extendString(token: StringToken, text: string): void {
		token.text += text;
		if (token.key) return;
		this.#put(token.location, token.text);
		if (token.path === undefined) return;
		if (token.change !== undefined && this.#changes.at(-1) === token.change) {
			if (token.change.kind === "append") token.change.text += text;
			else token.change.value = String(token.change.value) + text;
		} else {
			token.change = { kind: "append", path: token.path, text };
			this.#changes.push(token.change);
		}
	}
}
function scalar(text: string, partial: boolean): JsonValue | undefined {
	for (const [literal, value] of LITERALS) if (partial ? literal.startsWith(text) : literal === text) return value;
	if (NUMBER.test(text)) return Number(text);
	if (partial) { const match = EXPONENT.exec(text); if (match !== null) return Number(match[1]); }
	return undefined;
}
function put(container: Container, location: Location, value: JsonValue): void {
	if (location.kind === "root") return;
	if (Array.isArray(container) && location.kind === "item") container[location.key] = value;
	else Object.defineProperty(container, location.key, { value, enumerable: true, configurable: true, writable: true });
}

export class ToolCallArgumentsStream {
	#text = "";
	#parser = new StreamingJsonParser();
	#last: JsonValue | undefined;
	#arguments: ToolCall["arguments"] = {};
	get text(): string { return this.#text; }
	append(delta: string): ToolCall["arguments"] {
		this.#text += delta;
		this.#parser.append(delta);
		return this.#partial();
	}
	replace(text: string): { readonly delta: string | undefined; readonly arguments: ToolCall["arguments"] } {
		if (text.startsWith(this.#text)) {
			const delta = text.slice(this.#text.length);
			return { delta, arguments: delta === "" ? this.#partial() : this.append(delta) };
		}
		this.#text = "";
		this.#parser = new StreamingJsonParser();
		return { delta: undefined, arguments: this.append(text) };
	}
	finish(): Pick<ToolCall, "arguments" | "argumentsError"> { return parseToolCallArguments(this.#text); }
	#partial(): ToolCall["arguments"] {
		const value = this.#parser.snapshot();
		if (value !== this.#last) {
			this.#last = value;
			this.#arguments = value !== null && typeof value === "object" && !Array.isArray(value) ? value as ToolCall["arguments"] : {};
		}
		return this.#arguments;
	}
}
