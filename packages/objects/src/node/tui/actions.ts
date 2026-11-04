import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { BridgeRequest } from "../../tui/bridge.ts";
export type PromptTerminal = {
	readonly columns: number;
	ask(lines: readonly string[]): Promise<boolean>;
	write(data: string): void;
};
export function wrap(line: string, width: number): string[] {
	const rows: string[] = [];
	let row = "",
		columns = 0;
	for (const character of line.replace(/[\p{Cc}\p{Cf}]/gu, "")) {
		const size = character >= " " && character <= "~" ? 1 : 2;
		if (columns + size > width) {
			rows.push(row);
			row = "";
			columns = 0;
		}
		row += character;
		columns += size;
	}
	rows.push(row);
	return rows;
}
export function promptLines(lines: readonly string[], columns: number): string[] {
	return lines.flatMap((line) => wrap(line, Math.max(10, columns - 2)));
}
export function openerCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
	return platform === "win32"
		? ["rundll32", ["url.dll,FileProtocolHandler", url]]
		: [platform === "darwin" ? "open" : "xdg-open", [url]];
}
async function openBrowser(url: string): Promise<void> {
	const [command, args] = openerCommand(url);
	spawn(command, args, { stdio: "ignore", detached: true, cwd: "/", shell: false })
		.on("error", () => {})
		.unref();
}
export async function act(
	request: Extract<BridgeRequest, { kind: "copy" | "open" }>,
	terminal: PromptTerminal,
	opener: (url: string) => Promise<void> = openBrowser,
): Promise<boolean> {
	if (request.kind === "copy") {
		const text = request.text;
		if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(text))
			throw new Error("copy: the text holds control characters");
		const lines = text.split("\n"),
			rows = lines.flatMap((line) => wrap(line, Math.max(10, terminal.columns - 2) - 2)),
			hidden = rows.slice(5).reduce((total, row) => total + row.length, 0);
		const prompt = rows.slice(0, 5).map((row) => "  " + row);
		if (hidden > 0) prompt.push(`  … and ${hidden} more characters`);
		prompt.push(`Copy these ${text.length} characters (${lines.length} line${lines.length === 1 ? "" : "s"})? [y/N]`);
		if (!(await terminal.ask(prompt))) return false;
		terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		return true;
	}
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		throw new Error("open: only http and https URLs without user info open");
	}
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
		throw new Error("open: only http and https URLs without user info open");
	if (!(await terminal.ask([`  ${url.href}`, `Open ${url.host} in the browser? [y/N]`]))) return false;
	await opener(url.href);
	return true;
}
export const MAX_ATTACHMENT = 16 * 1024 * 1024;
const unavailable = () => new Error("attach: that file cannot be attached");
export async function attach(
	path: string,
	terminal: PromptTerminal,
	platform: NodeJS.Platform = process.platform,
): Promise<{ readonly name: string; readonly bytes: Uint8Array } | null> {
	if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|[^\S ]| {2}|^ | $/u.test(path)) throw unavailable();
	if (
		platform === "win32" &&
		(/^[\\/]{2}/.test(path) ||
			path
				.split(/[\\/]/)
				.some((segment) => /^(?:con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(?:\..*)?$/i.test(segment)))
	)
		throw unavailable();
	const paths = platform === "win32" ? win32 : posix,
		named = paths.resolve(/^~(?:$|[\\/])/.test(path) ? paths.join(homedir(), path.slice(1)) : path);
	const prompt = (file: string, question: string) => [
		`File: ${paths.basename(file)}`,
		`In:   ${paths.dirname(file)}`,
		question,
	];
	if (!(await terminal.ask(prompt(named, "Attach this file? [y/N]")))) return null;
	const file = await realpath(named).catch(() => undefined);
	if (!file) throw unavailable();
	const shown = await stat(file, { bigint: true }).catch(() => undefined);
	if (!shown) throw unavailable();
	if (file !== named && !(await terminal.ask(prompt(file, "It links here. Attach this file? [y/N]")))) return null;
	const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)).catch(
		() => undefined,
	);
	if (!handle) throw unavailable();
	try {
		const current = await handle.stat({ bigint: true });
		if (
			!current.isFile() ||
			current.dev !== shown.dev ||
			current.ino !== shown.ino ||
			current.size > BigInt(MAX_ATTACHMENT)
		)
			throw unavailable();
		const bytes = new Uint8Array(Number(current.size));
		let length = 0;
		while (length < bytes.length) {
			const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		return { name: paths.basename(file), bytes: bytes.subarray(0, length) };
	} finally {
		await handle.close();
	}
}
