type Letter =
	| "a"
	| "b"
	| "c"
	| "d"
	| "e"
	| "f"
	| "g"
	| "h"
	| "i"
	| "j"
	| "k"
	| "l"
	| "m"
	| "n"
	| "o"
	| "p"
	| "q"
	| "r"
	| "s"
	| "t"
	| "u"
	| "v"
	| "w"
	| "x"
	| "y"
	| "z";
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type SymbolKey =
	| "`"
	| "-"
	| "="
	| "["
	| "]"
	| "\\"
	| ";"
	| "'"
	| ","
	| "."
	| "/"
	| "!"
	| "@"
	| "#"
	| "$"
	| "%"
	| "^"
	| "&"
	| "*"
	| "("
	| ")"
	| "_"
	| "+"
	| "|"
	| "~"
	| "{"
	| "}"
	| ":"
	| "<"
	| ">"
	| "?";
type Special =
	| "escape"
	| "esc"
	| "enter"
	| "return"
	| "tab"
	| "space"
	| "backspace"
	| "delete"
	| "insert"
	| "clear"
	| "home"
	| "end"
	| "pageUp"
	| "pageDown"
	| "up"
	| "down"
	| "left"
	| "right"
	| `f${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12}`;
type BaseKey = Letter | Digit | SymbolKey | Special;
type Modifier = "shift" | "alt" | "ctrl" | "super";
type Modified<K extends string, M extends Modifier = Modifier> = {
	[P in M]: `${P}+${K}` | `${P}+${Modified<K, Exclude<M, P>>}`;
}[M];
export type KeyId = BaseKey | Modified<BaseKey>;
export type KeyEventType = "press" | "repeat" | "release";

export const Key = {
	escape: "escape",
	esc: "esc",
	enter: "enter",
	return: "return",
	tab: "tab",
	space: "space",
	backspace: "backspace",
	delete: "delete",
	insert: "insert",
	clear: "clear",
	home: "home",
	end: "end",
	pageUp: "pageUp",
	pageDown: "pageDown",
	up: "up",
	down: "down",
	left: "left",
	right: "right",
	f1: "f1",
	f2: "f2",
	f3: "f3",
	f4: "f4",
	f5: "f5",
	f6: "f6",
	f7: "f7",
	f8: "f8",
	f9: "f9",
	f10: "f10",
	f11: "f11",
	f12: "f12",
	backtick: "`",
	hyphen: "-",
	equals: "=",
	leftbracket: "[",
	rightbracket: "]",
	backslash: "\\",
	semicolon: ";",
	quote: "'",
	comma: ",",
	period: ".",
	slash: "/",
	exclamation: "!",
	at: "@",
	hash: "#",
	dollar: "$",
	percent: "%",
	caret: "^",
	ampersand: "&",
	asterisk: "*",
	leftparen: "(",
	rightparen: ")",
	underscore: "_",
	plus: "+",
	pipe: "|",
	tilde: "~",
	leftbrace: "{",
	rightbrace: "}",
	colon: ":",
	lessthan: "<",
	greaterthan: ">",
	question: "?",
	ctrl: <K extends BaseKey>(key: K): `ctrl+${K}` => `ctrl+${key}`,
	shift: <K extends BaseKey>(key: K): `shift+${K}` => `shift+${key}`,
	alt: <K extends BaseKey>(key: K): `alt+${K}` => `alt+${key}`,
	super: <K extends BaseKey>(key: K): `super+${K}` => `super+${key}`,
	ctrlShift: <K extends BaseKey>(key: K): `ctrl+shift+${K}` => `ctrl+shift+${key}`,
	shiftCtrl: <K extends BaseKey>(key: K): `shift+ctrl+${K}` => `shift+ctrl+${key}`,
	ctrlAlt: <K extends BaseKey>(key: K): `ctrl+alt+${K}` => `ctrl+alt+${key}`,
	altCtrl: <K extends BaseKey>(key: K): `alt+ctrl+${K}` => `alt+ctrl+${key}`,
	shiftAlt: <K extends BaseKey>(key: K): `shift+alt+${K}` => `shift+alt+${key}`,
	altShift: <K extends BaseKey>(key: K): `alt+shift+${K}` => `alt+shift+${key}`,
	ctrlSuper: <K extends BaseKey>(key: K): `ctrl+super+${K}` => `ctrl+super+${key}`,
	superCtrl: <K extends BaseKey>(key: K): `super+ctrl+${K}` => `super+ctrl+${key}`,
	shiftSuper: <K extends BaseKey>(key: K): `shift+super+${K}` => `shift+super+${key}`,
	superShift: <K extends BaseKey>(key: K): `super+shift+${K}` => `super+shift+${key}`,
	altSuper: <K extends BaseKey>(key: K): `alt+super+${K}` => `alt+super+${key}`,
	superAlt: <K extends BaseKey>(key: K): `super+alt+${K}` => `super+alt+${key}`,
	ctrlShiftAlt: <K extends BaseKey>(key: K): `ctrl+shift+alt+${K}` => `ctrl+shift+alt+${key}`,
	ctrlShiftSuper: <K extends BaseKey>(key: K): `ctrl+shift+super+${K}` => `ctrl+shift+super+${key}`,
} as const;

let kittyActive = false;
export function setKittyProtocolActive(active: boolean): void {
	kittyActive = active;
}
export function isKittyProtocolActive(): boolean {
	return kittyActive;
}
export function isKeyRelease(data: string): boolean {
	return !data.includes("\x1b[200~") && /:3[u~ABCDHF]/.test(data);
}
export function isKeyRepeat(data: string): boolean {
	return !data.includes("\x1b[200~") && /:2[u~ABCDHF]/.test(data);
}

const symbols = new Set("`-=[]\\;',./!@#$%^&*()_+|~{}:<>?");
const shiftedSymbols = new Set("~!@#$%^&*()_+|{}:<>?");
const names = new Map<number, string>([
	[27, "escape"],
	[9, "tab"],
	[13, "enter"],
	[57414, "enter"],
	[32, "space"],
	[127, "backspace"],
	[-1, "up"],
	[-2, "down"],
	[-3, "right"],
	[-4, "left"],
	[-10, "delete"],
	[-11, "insert"],
	[-12, "pageUp"],
	[-13, "pageDown"],
	[-14, "home"],
	[-15, "end"],
]);
const functional = new Map<number, number>([
	[2, -11],
	[3, -10],
	[5, -12],
	[6, -13],
	[7, -14],
	[8, -15],
]);
const navigationCodes = new Map<string, number>([
	["A", -1],
	["B", -2],
	["C", -3],
	["D", -4],
	["H", -14],
	["F", -15],
]);
const keypad = [
	48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 46, 47, 42, 45, 43, 57414, 61, 44, -4, -3, -1, -2, -12, -13, -14, -15, -11,
	-10,
];
function normalize(code: number): number {
	return keypad[code - 57399] ?? code;
}
function letterIdentity(code: number, modifiers: number): number {
	return modifiers & 1 && code >= 65 && code <= 90 ? code + 32 : code;
}
function windowsBackspace(): boolean {
	return (
		Boolean(process.env.WT_SESSION) && !process.env.SSH_CONNECTION && !process.env.SSH_CLIENT && !process.env.SSH_TTY
	);
}

interface Sequence {
	code: number;
	modifiers: number;
	shifted?: number;
	base?: number;
}
function csi(data: string): Sequence | undefined {
	let match = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/.exec(data);
	if (match)
		return {
			code: Number(match[1]),
			modifiers: Number(match[4] ?? 1) - 1,
			shifted: match[2] ? Number(match[2]) : undefined,
			base: match[3] ? Number(match[3]) : undefined,
		};
	match = /^\x1b\[1;(\d+)(?::\d+)?([ABCDHF])$/.exec(data);
	if (match) {
		const code = navigationCodes.get(match[2]);
		if (code !== undefined) return { code, modifiers: Number(match[1]) - 1 };
	}
	match = /^\x1b\[(\d+)(?:;(\d+))?(?::\d+)?~$/.exec(data);
	if (match) {
		const code = functional.get(Number(match[1]));
		if (code !== undefined) return { code, modifiers: Number(match[2] ?? 1) - 1 };
	}
	return undefined;
}
function otherKeys(data: string): Sequence | undefined {
	const match = /^\x1b\[27;(\d+);(\d+)~$/.exec(data);
	return match ? { code: Number(match[2]), modifiers: Number(match[1]) - 1 } : undefined;
}
function named(code: number): string | undefined {
	return (
		names.get(code) ??
		((code >= 48 && code <= 57) || (code >= 97 && code <= 122) || symbols.has(String.fromCharCode(code))
			? String.fromCharCode(code)
			: undefined)
	);
}
function format(sequence: Sequence): string | undefined {
	const modifiers = sequence.modifiers & ~192;
	if (modifiers & ~15) return undefined;
	const code = letterIdentity(normalize(sequence.code), sequence.modifiers);
	const authoritative =
		(code >= 97 && code <= 122) || (code >= 48 && code <= 57) || symbols.has(String.fromCharCode(code));
	const key = named(authoritative ? code : (sequence.base ?? code));
	if (!key) return undefined;
	const prefixes: string[] = [];
	if (modifiers & 1) prefixes.push("shift");
	if (modifiers & 4) prefixes.push("ctrl");
	if (modifiers & 2) prefixes.push("alt");
	if (modifiers & 8) prefixes.push("super");
	return [...prefixes, key].join("+");
}

const legacy = new Map<string, string>();
function sequences(key: string, values: string[]): void {
	for (const value of values) legacy.set(value, key);
}
for (const [letter, key] of Object.entries({
	A: "up",
	B: "down",
	C: "right",
	D: "left",
	H: "home",
	F: "end",
	E: "clear",
})) {
	sequences(key, [`\x1b[${letter}`, `\x1bO${letter}`]);
	if ("ABCDE".includes(letter)) {
		sequences(`shift+${key}`, [`\x1b[${letter.toLowerCase()}`]);
		sequences(`ctrl+${key}`, [`\x1bO${letter.toLowerCase()}`]);
	}
}
for (const [code, key] of [
	[2, "insert"],
	[3, "delete"],
	[5, "pageUp"],
	[6, "pageDown"],
	[7, "home"],
	[8, "end"],
] satisfies [number, string][]) {
	sequences(key, [`\x1b[${code}~`]);
	sequences(`shift+${key}`, [`\x1b[${code}$`]);
	sequences(`ctrl+${key}`, [`\x1b[${code}^`]);
}
sequences("home", ["\x1b[1~"]);
sequences("end", ["\x1b[4~"]);
sequences("pageUp", ["\x1b[[5~"]);
sequences("pageDown", ["\x1b[[6~"]);
for (const [index, code] of [11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24].entries()) {
	sequences(`f${index + 1}`, [`\x1b[${code}~`]);
	if (index < 4) sequences(`f${index + 1}`, [`\x1bO${String.fromCharCode(80 + index)}`]);
	if (index < 5) sequences(`f${index + 1}`, [`\x1b[[${String.fromCharCode(65 + index)}`]);
}
for (const [key, char] of [
	["left", "b"],
	["right", "f"],
	["up", "p"],
	["down", "n"],
])
	sequences(`alt+${key}`, [`\x1b${char}`]);

export function parseKey(data: string): string | undefined {
	const kitty = csi(data);
	const parsed = kitty ?? otherKeys(data);
	if (parsed) {
		const logical = logicalSymbol(
			kitty ? parsed.shifted : parsed.code,
			parsed.modifiers,
			kitty ? symbols : shiftedSymbols,
		);
		return format(logical ? { ...parsed, code: logical.code, modifiers: logical.modifiers } : parsed);
	}
	if (kittyActive && (data === "\x1b\r" || data === "\n")) return "shift+enter";
	const known = legacy.get(data);
	if (known && data !== "\x1b[1~" && data !== "\x1b[4~") return known;
	const fixed = new Map<string, string>([
		["\x1b", "escape"],
		["\x1c", "ctrl+\\"],
		["\x1d", "ctrl+]"],
		["\x1f", "ctrl+-"],
		["\x1b\x1b", "ctrl+alt+["],
		["\x1b\x1c", "ctrl+alt+\\"],
		["\x1b\x1d", "ctrl+alt+]"],
		["\x1b\x1f", "ctrl+alt+-"],
		["\t", "tab"],
		["\r", "enter"],
		["\x1bOM", "enter"],
		["\0", "ctrl+space"],
		[" ", "space"],
		["\x7f", "backspace"],
		["\x08", windowsBackspace() ? "ctrl+backspace" : "backspace"],
		["\x1b[Z", "shift+tab"],
		["\x1b\x7f", "alt+backspace"],
		["\x1b\b", "alt+backspace"],
	]);
	const result = fixed.get(data);
	if (result) return result;
	if (!kittyActive) {
		if (data === "\n") return "enter";
		if (data === "\x1b\r") return "alt+enter";
		if (data === "\x1b ") return "alt+space";
		if (data === "\x1bB") return "alt+left";
		if (data === "\x1bF") return "alt+right";
		if (data.length === 2 && data[0] === "\x1b") {
			const code = data.charCodeAt(1);
			if (code >= 1 && code <= 26) return `ctrl+alt+${String.fromCharCode(code + 96)}`;
			if (named(code) === data[1]) return `alt+${data[1]}`;
		}
	}
	if (data.length === 1) {
		const code = data.charCodeAt(0);
		if (code >= 1 && code <= 26) return `ctrl+${String.fromCharCode(code + 96)}`;
		if (code >= 32 && code <= 126) return data;
	}
	return undefined;
}

function logicalSymbol(
	code: number | undefined,
	modifiers: number,
	allowed: ReadonlySet<string>,
): Sequence | undefined {
	if (code === undefined || !(modifiers & 1) || !allowed.has(String.fromCharCode(normalize(code)))) return undefined;
	return { code: normalize(code), modifiers: modifiers & ~1 };
}

export function matchesKey(data: string, keyId: KeyId): boolean {
	let key: string = keyId.toLowerCase();
	const parts = new Set<string>();
	while (true) {
		const name = ["shift", "alt", "ctrl", "super"].find((modifier) => key.startsWith(modifier + "+"));
		if (!name) break;
		if (parts.has(name)) return false;
		parts.add(name);
		key = key.slice(name.length + 1);
	}
	if (!key || (key.includes("+") && key !== "+")) return false;
	const modifiers =
		(parts.has("shift") ? 1 : 0) |
		(parts.has("alt") ? 2 : 0) |
		(parts.has("ctrl") ? 4 : 0) |
		(parts.has("super") ? 8 : 0);
	const canonical = key === "esc" ? "escape" : key === "return" ? "enter" : key;
	if (canonical === "escape" && modifiers !== 0) return false;
	if (modifiers === 0 && ((canonical === "home" && data === "\x1b[1~") || (canonical === "end" && data === "\x1b[4~")))
		return true;
	if (/^f\d+$/.test(key) || canonical === "clear")
		return modifiers === 0
			? legacy.get(data)?.toLowerCase() === canonical
			: legacy.get(data)?.toLowerCase() ===
					`${modifiers === 1 ? "shift" : modifiers === 4 ? "ctrl" : "unsupported"}+${canonical}`;
	let expected: number | undefined;
	for (const [code, name] of names) if (name.toLowerCase() === canonical && code !== 57414) expected = code;
	if (key.length === 1 && (/[a-z0-9]/.test(key) || symbols.has(key))) expected = key.charCodeAt(0);
	if (expected === undefined) return false;
	const parsed = csi(data);
	if (parsed) {
		const logical = logicalSymbol(parsed.shifted, parsed.modifiers & ~192, symbols);
		if (logical?.modifiers === modifiers && logical.code === normalize(expected)) return true;
	}
	if (parsed && (parsed.modifiers & ~192) === modifiers) {
		const actual = letterIdentity(normalize(parsed.code), parsed.modifiers);
		if (actual === letterIdentity(expected, modifiers) || (canonical === "enter" && actual === 57414)) return true;
		if (parsed.base === expected && !(actual >= 97 && actual <= 122) && !symbols.has(String.fromCharCode(actual)))
			return true;
	}
	const other = otherKeys(data);
	if (other && key.length === 1) {
		const logical = logicalSymbol(other.code, other.modifiers, shiftedSymbols);
		if (logical?.modifiers === modifiers && logical.code === expected) return true;
	}
	if (other && other.modifiers === modifiers) {
		if (letterIdentity(other.code, modifiers) === letterIdentity(expected, modifiers)) {
			if ((canonical !== "tab" && canonical !== "enter") || modifiers !== 0) return true;
		}
	}
	const parsedLegacy = parseKey(data)?.toLowerCase();
	const prefix: string[] = [];
	if (modifiers & 1) prefix.push("shift");
	if (modifiers & 4) prefix.push("ctrl");
	if (modifiers & 2) prefix.push("alt");
	if (modifiers & 8) prefix.push("super");
	if (key.length > 1 && !parsed && !other && parsedLegacy === [...prefix, canonical].join("+")) {
		if (canonical === "space" && modifiers !== 0 && kittyActive) return false;
		return true;
	}
	if (key.length === 1) {
		const control = /^[a-z\[\\\]_\-]$/.test(key)
			? String.fromCharCode((key === "-" ? 95 : key.charCodeAt(0)) & 31)
			: undefined;
		if (modifiers === 4 && control === data) return true;
		if (modifiers === 6 && !kittyActive && control !== undefined && `\x1b${control}` === data) return true;
		if (modifiers === 2 && !kittyActive && data === `\x1b${key}`) return true;
		if (modifiers === 1 && /^[a-z]$/.test(key) && data === key.toUpperCase()) return true;
		if (modifiers === 0 && data === key) return true;
	}
	return false;
}

function printable(sequence: Sequence | undefined, useShifted: boolean): string | undefined {
	if (!sequence || (sequence.modifiers & ~193) !== 0) return undefined;
	const code = useShifted
		? normalize(sequence.modifiers & 1 ? (sequence.shifted ?? sequence.code) : sequence.code)
		: sequence.code;
	if (!Number.isInteger(code) || code < 32 || code > 0x10ffff) return undefined;
	return String.fromCodePoint(code);
}
export function decodeKittyPrintable(data: string): string | undefined {
	return data.endsWith("u") ? printable(csi(data), true) : undefined;
}
export function decodePrintableKey(data: string): string | undefined {
	return decodeKittyPrintable(data) ?? printable(otherKeys(data), false);
}
