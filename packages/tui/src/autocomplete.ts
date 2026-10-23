import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fuzzyFilter } from "./fuzzy.ts";
import { autocompleteBoundaryRegex, autocompleteSeparatorRegex } from "./utils.ts";
export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
}
export interface SlashCommand {
	name: string;
	description?: string;
	argumentHint?: string;
	getArgumentCompletions?(argumentPrefix: string): AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
}
export interface AutocompleteSuggestions {
	items: AutocompleteItem[];
	prefix: string;
}
export interface AutocompleteProvider {
	triggerCharacters?: string[];
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null>;
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number };
	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}
const wrappers: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">", "`": "`" };
const delimiters = new Set([" ", "\t", '"', "'", "="]);
const boundary = new RegExp(`${autocompleteBoundaryRegex.source}$`, "u");
const display = (path: string) => path.replace(/\\/g, "/");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function tokenStart(text: string, index: number): boolean {
	while (index > 0 && wrappers[text[index - 1]!]) index--;
	return delimiters.has(text[index - 1] ?? "") || boundary.test(text.slice(0, index));
}
function quoted(text: string): string | null {
	let start = -1,
		open = false;
	for (let index = 0; index < text.length; index++)
		if (text[index] === '"') {
			open = !open;
			if (open) start = index;
		}
	if (!open) return null;
	const at = start > 0 && text[start - 1] === "@" ? start - 1 : start;
	return tokenStart(text, at) ? text.slice(at) : null;
}
function token(text: string): string {
	let start = 0,
		index = 0;
	for (const char of text) {
		index += char.length;
		if (delimiters.has(char) || autocompleteSeparatorRegex.test(char)) start = index;
	}
	let result = text.slice(start);
	while (result.length && wrappers[result[0]!] && !result.includes(wrappers[result[0]!]!, 1)) result = result.slice(1);
	return result;
}
function parse(prefix: string): { raw: string; at: boolean; quoted: boolean } {
	const at = prefix.startsWith("@"),
		rest = at ? prefix.slice(1) : prefix,
		quoted = rest.startsWith('"');
	return { raw: quoted ? rest.slice(1) : rest, at, quoted };
}
function completion(path: string, at: boolean, quoted: boolean): string {
	return (at ? "@" : "") + (quoted || autocompleteSeparatorRegex.test(path) ? `"${path}"` : path);
}
function expand(path: string): string {
	if (path === "~") return homedir();
	if (!path.startsWith("~/")) return path;
	const full = join(homedir(), path.slice(2));
	return path.endsWith("/") && !full.endsWith("/") ? full + "/" : full;
}
type Entry = { path: string; isDirectory: boolean };
async function walk(base: string, fd: string, query: string, signal: AbortSignal, depth?: number): Promise<Entry[]> {
	const args = [
		"--base-directory",
		base,
		"--max-results",
		"100",
		"--type",
		"f",
		"--type",
		"d",
		"--follow",
		"--hidden",
		"--exclude",
		".git",
		"--exclude",
		".git/*",
		"--exclude",
		".git/**",
	];
	if (depth !== undefined) args.push("--max-depth", String(depth));
	const normalized = display(query);
	if (normalized.includes("/")) args.push("--full-path");
	if (query) {
		const trimmed = normalized.replace(/^\/+|\/+$/g, "");
		args.push(
			normalized.includes("/") && trimmed
				? trimmed.split("/").filter(Boolean).map(escape).join("[\\\\/]") + (normalized.endsWith("/") ? "[\\\\/]" : "")
				: escape(normalized),
		);
	}
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve([]);
			return;
		}
		const child = spawn(fd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let output = "",
			done = false;
		const abort = () => {
			if (child.exitCode === null) child.kill("SIGKILL");
		};
		const finish = (entries: Entry[]) => {
			if (done) return;
			done = true;
			signal.removeEventListener("abort", abort);
			resolve(entries);
		};
		signal.addEventListener("abort", abort, { once: true });
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
		});
		child.on("error", () => finish([]));
		child.on("close", (code) => {
			if (signal.aborted || code !== 0 || !output) {
				finish([]);
				return;
			}
			finish(
				output
					.trim()
					.split("\n")
					.filter(Boolean)
					.map(display)
					.filter((path) => {
						const plain = path.endsWith("/") ? path.slice(0, -1) : path;
						return plain !== ".git" && !plain.startsWith(".git/") && !plain.includes("/.git/");
					})
					.map((path) => ({ path, isDirectory: path.endsWith("/") })),
			);
		});
	});
}
export class CombinedAutocompleteProvider implements AutocompleteProvider {
	readonly #commands: (SlashCommand | AutocompleteItem)[];
	readonly #base: string;
	readonly #fd: string | null;
	constructor(commands: (SlashCommand | AutocompleteItem)[] = [], basePath: string, fdPath: string | null = null) {
		this.#commands = commands;
		this.#base = basePath;
		this.#fd = fdPath;
	}
	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const text = (lines[cursorLine] ?? "").slice(0, cursorCol),
			quote = quoted(text),
			last = token(text),
			at = quote?.startsWith('@"') ? quote : last.startsWith("@") ? last : null;
		if (at) {
			const prefix = parse(at),
				items = await this.fuzzyFiles(prefix.raw, prefix.quoted, options.signal);
			return items.length ? { items, prefix: at } : null;
		}
		const command = text.trimStart();
		if (!options.force && command.startsWith("/")) {
			const space = command.indexOf(" ");
			if (space < 0) {
				const all = this.#commands.map((cmd) => {
					const name = "name" in cmd ? cmd.name : cmd.value,
						hint = "argumentHint" in cmd ? cmd.argumentHint : undefined,
						desc = cmd.description ?? "";
					return { name, label: name, description: hint ? (desc ? `${hint} — ${desc}` : hint) : desc };
				});
				const bare = fuzzyFilter(all, command.slice(1), (item) =>
						item.name.startsWith("skill:") ? item.name.slice(6) : item.name,
					),
					seen = new Set(bare);
				const extra = fuzzyFilter(
					all.filter((item) => item.name.startsWith("skill:") && !seen.has(item)),
					command.slice(1),
					(item) => item.name,
				);
				const items = [...bare, ...extra].map((item) => ({
					value: item.name,
					label: item.label,
					...(item.description ? { description: item.description } : {}),
				}));
				return items.length ? { items, prefix: command } : null;
			}
			const name = command.slice(1, space),
				prefix = command.slice(space + 1),
				found = this.#commands.find((cmd) => ("name" in cmd ? cmd.name : cmd.value) === name);
			if (!found || !("getArgumentCompletions" in found) || !found.getArgumentCompletions) return null;
			const items = await found.getArgumentCompletions(prefix);
			return Array.isArray(items) && items.length ? { items, prefix } : null;
		}
		const prefix =
			quote ??
			(options.force ||
			last.includes("/") ||
			last.startsWith(".") ||
			last.startsWith("~/") ||
			(last === "" && text !== "" && boundary.test(text))
				? last
				: null);
		if (prefix === null) return null;
		const items = this.files(prefix);
		return items.length ? { items, prefix } : null;
	}
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const line = lines[cursorLine] ?? "",
			before = line.slice(0, cursorCol - prefix.length);
		let after = line.slice(cursorCol);
		if ((prefix.startsWith('"') || prefix.startsWith('@"')) && item.value.endsWith('"') && after.startsWith('"'))
			after = after.slice(1);
		const command = prefix.startsWith("/") && before.trim() === "" && !prefix.slice(1).includes("/"),
			directory = item.label.endsWith("/");
		const value = command ? "/" + item.value + " " : item.value + (prefix.startsWith("@") && !directory ? " " : "");
		const output = [...lines];
		output[cursorLine] = before + value + after;
		const offset = !command && directory && item.value.endsWith('"') ? 1 : 0;
		return { lines: output, cursorLine, cursorCol: before.length + value.length - offset };
	}
	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const text = (lines[cursorLine] ?? "").slice(0, cursorCol).trim();
		return !(text.startsWith("/") && !text.includes(" "));
	}
	private files(prefix: string): AutocompleteItem[] {
		try {
			const { raw, at, quoted } = parse(prefix),
				expanded = raw.startsWith("~") ? expand(raw) : raw;
			const root = ["", "./", "../", "~", "~/", "/"].includes(raw) || raw.endsWith("/");
			const dir = root ? expanded : dirname(expanded),
				search = root ? "" : basename(expanded),
				absolute = raw.startsWith("~") || expanded.startsWith("/");
			const searchDir = absolute ? dir : join(this.#base, dir),
				items: AutocompleteItem[] = [];
			for (const entry of readdirSync(searchDir, { withFileTypes: true })) {
				if (!entry.name.toLowerCase().startsWith(search.toLowerCase())) continue;
				let directory = entry.isDirectory();
				if (!directory && entry.isSymbolicLink())
					try {
						directory = statSync(join(searchDir, entry.name)).isDirectory();
					} catch {}
				let path: string;
				if (raw.endsWith("/")) path = raw + entry.name;
				else if (raw.includes("/") || raw.includes("\\")) {
					if (raw.startsWith("~/")) {
						const part = dirname(raw.slice(2));
						path = "~/" + (part === "." ? entry.name : join(part, entry.name));
					} else if (raw.startsWith("/")) {
						const part = dirname(raw);
						path = (part === "/" ? "/" : part + "/") + entry.name;
					} else {
						path = join(dirname(raw), entry.name);
						if (raw.startsWith("./") && !path.startsWith("./")) path = "./" + path;
					}
				} else path = (raw.startsWith("~") ? "~/" : "") + entry.name;
				path = display(path) + (directory ? "/" : "");
				items.push({ value: completion(path, at, quoted), label: entry.name + (directory ? "/" : "") });
			}
			return items.sort(
				(a, b) => Number(b.label.endsWith("/")) - Number(a.label.endsWith("/")) || a.label.localeCompare(b.label),
			);
		} catch {
			return [];
		}
	}
	private async fuzzyFiles(query: string, quoted: boolean, signal: AbortSignal): Promise<AutocompleteItem[]> {
		if (!this.#fd || signal.aborted) return [];
		try {
			let base = this.#base,
				filter = query,
				displayBase: string | undefined;
			const normalized = display(query),
				slash = normalized.lastIndexOf("/");
			if (slash >= 0) {
				const prefix = normalized.slice(0, slash + 1),
					candidate = prefix.startsWith("~/")
						? expand(prefix)
						: prefix.startsWith("/")
							? prefix
							: join(this.#base, prefix);
				try {
					if (statSync(candidate).isDirectory()) {
						base = candidate;
						filter = normalized.slice(slash + 1);
						displayBase = prefix;
					}
				} catch {}
			}
			const top = await walk(base, this.#fd, filter, signal, 1),
				deep = await walk(base, this.#fd, filter, signal),
				seen = new Set(top.map((entry) => entry.path)),
				entries = [...top];
			for (const entry of deep)
				if (!seen.has(entry.path)) {
					seen.add(entry.path);
					entries.push(entry);
				}
			if (signal.aborted) return [];
			const lower = filter.toLowerCase();
			const ranked = entries
				.map((entry) => {
					const name = basename(entry.path).toLowerCase(),
						score = !filter
							? 1
							: name === lower
								? 100
								: name.startsWith(lower)
									? 80
									: name.includes(lower)
										? 50
										: entry.path.toLowerCase().includes(lower)
											? 30
											: 0;
					return { ...entry, score: score + (filter && entry.isDirectory && score > 0 ? 10 : 0) };
				})
				.filter((entry) => entry.score > 0)
				.sort(
					(a, b) =>
						b.score - a.score ||
						display(a.path).split("/").filter(Boolean).length - display(b.path).split("/").filter(Boolean).length ||
						a.path.length - b.path.length ||
						a.path.localeCompare(b.path),
				);
			return ranked.slice(0, 20).map((entry) => {
				const plain = entry.isDirectory ? entry.path.slice(0, -1) : entry.path,
					path = displayBase !== undefined ? displayBase + display(plain) : plain;
				return {
					value: completion(path + (entry.isDirectory ? "/" : ""), true, quoted),
					label: basename(plain) + (entry.isDirectory ? "/" : ""),
					description: path,
				};
			});
		} catch {
			return [];
		}
	}
}
