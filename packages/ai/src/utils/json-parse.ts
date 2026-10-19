import { parse } from "partial-json";
import type { ToolCall } from "../types.ts";
const escapes = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
function escapeControl(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}
export function repairJson(json: string): string {
	let output = "";
	let quoted = false;
	for (let cursor = 0; cursor < json.length; cursor++) {
		const char = json[cursor];
		if (char === '"') {
			quoted = !quoted;
			output += char;
			continue;
		}
		if (!quoted) {
			output += char;
			continue;
		}
		if (char === "\\") {
			const next = json[cursor + 1];
			if (next === "u" && /^[0-9a-f]{4}$/i.test(json.slice(cursor + 2, cursor + 6))) {
				output += json.slice(cursor, cursor + 6);
				cursor += 5;
			} else if (next !== undefined && escapes.has(next)) {
				output += char + next;
				cursor++;
			} else output += "\\\\";
		} else {
			const code = char.codePointAt(0);
			output += code !== undefined && code >= 0 && code <= 31 ? escapeControl(char) : char;
		}
	}
	return output;
}
export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json);
	} catch (error) {
		const fixed = repairJson(json);
		if (fixed === json) throw error;
		return JSON.parse(fixed);
	}
}
export function parseToolCallArguments(json: string | undefined): Pick<ToolCall, "arguments" | "argumentsError"> {
	if (!json?.trim()) return { arguments: {} };
	try {
		const value = parseJsonWithRepair<ToolCall["arguments"] | null>(json);
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new Error("Tool arguments must be a JSON object");
		return { arguments: value };
	} catch (error) {
		return {
			arguments: {},
			argumentsError: `${error instanceof Error ? error.message : String(error)}\n\nReceived arguments:\n${json}`,
		};
	}
}
export function parseStreamingJson<T = Record<string, unknown>>(json: string | undefined): T {
	if (!json?.trim()) return {} as T;
	try {
		return parseJsonWithRepair<T>(json);
	} catch {}
	try {
		return (parse(json) ?? {}) as T;
	} catch {
		try {
			return (parse(repairJson(json)) ?? {}) as T;
		} catch {
			return {} as T;
		}
	}
}
