export const CODEMODE_OPTIONS_PREFIX = "// @options:";
export const CODEMODE_SOURCE_GRAMMAR = String.raw`
start: options_source | plain_source
options_source: OPTIONS_LINE NEWLINE SOURCE
plain_source: SOURCE

OPTIONS_LINE: /[ \t]*\/\/ @options:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`;
export interface CodemodeSourceOptions {
	maxOutputTokens?: number;
	timeoutMs?: number;
}
export interface ParsedCodemodeSource {
	code: string;
	options: CodemodeSourceOptions;
}
export class CodemodeSourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodemodeSourceError";
	}
}
const fields = "`max_output_tokens` and `timeout_ms`";
function readOptions(text: string): CodemodeSourceOptions {
	let parsed: unknown;
	if (!text) throw new CodemodeSourceError(`@options must be a JSON object with supported fields ${fields}`);
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new CodemodeSourceError(
			`@options must be valid JSON with supported fields ${fields}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new CodemodeSourceError(`@options must be a JSON object with supported fields ${fields}`);
	for (const key of Object.keys(parsed))
		if (key !== "max_output_tokens" && key !== "timeout_ms")
			throw new CodemodeSourceError(`@options only supports ${fields}; got \`${key}\``);
	const result: CodemodeSourceOptions = {};
	const { max_output_tokens, timeout_ms } = parsed as Record<string, unknown>;
	if (max_output_tokens !== undefined) {
		if (typeof max_output_tokens !== "number" || !Number.isSafeInteger(max_output_tokens) || max_output_tokens < 0)
			throw new CodemodeSourceError("@options field `max_output_tokens` must be a non-negative safe integer");
		result.maxOutputTokens = max_output_tokens;
	}
	if (timeout_ms !== undefined) {
		if (
			typeof timeout_ms !== "number" ||
			!Number.isSafeInteger(timeout_ms) ||
			timeout_ms < 1 ||
			timeout_ms > 2147483647
		)
			throw new CodemodeSourceError("@options field `timeout_ms` must be a positive integer up to 2147483647");
		result.timeoutMs = timeout_ms;
	}
	return result;
}
export function parseCodemodeSource(input: string): ParsedCodemodeSource {
	if (!input.trim())
		throw new CodemodeSourceError(
			'Expected JavaScript source text (non-empty). Provide JS only, optionally with a first line `// @options: {"max_output_tokens": 1000}`.',
		);
	const lines = input.split("\n");
	for (let i = 1; i < lines.length; i++)
		if (lines[i].trimStart().startsWith(CODEMODE_OPTIONS_PREFIX))
			throw new CodemodeSourceError(
				`The // @options: line must be the first line of the input; found one on line ${i + 1}`,
			);
	const first = lines[0].trimStart().replace(/\r$/, "");
	if (!first.startsWith(CODEMODE_OPTIONS_PREFIX)) return { code: input, options: {} };
	const end = input.indexOf("\n"),
		code = end < 0 ? "" : input.slice(end);
	if (!code.trim())
		throw new CodemodeSourceError("The @options line must be followed by JavaScript source on subsequent lines");
	return { code, options: readOptions(first.slice(CODEMODE_OPTIONS_PREFIX.length).trim()) };
}
