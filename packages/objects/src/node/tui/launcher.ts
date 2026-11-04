import type { Readable, Writable } from "node:stream";
import { WebSocket } from "ws";
import type { ColorDepth } from "../../surfaces/index.ts";
import type { BridgeRequest, SandboxMessage } from "../../tui/bridge.ts";
import type { TuiStart } from "../surfaces/tui.ts";
import { act, attach, promptLines, type PromptTerminal } from "./actions.ts";
import { tokenOf, type TerminalCredentials } from "./credentials.ts";
import { filterOutput } from "./filter.ts";
import { MAX_BUNDLE, requireSandboxNode, Sandbox } from "./sandbox.ts";
export type TerminalOptions = {
	readonly url: string;
	readonly credentials: TerminalCredentials;
	readonly input?: Readable & { setRawMode?(raw: boolean): unknown; readonly isTTY?: boolean };
	readonly output?: Writable & { readonly columns?: number; readonly rows?: number };
	readonly colors?: ColorDepth;
	readonly mode?: "dark" | "light";
	readonly locales?: readonly string[];
	readonly opener?: (url: string) => Promise<void>;
};
export type RunningTerminal = { readonly exited: Promise<number>; stop(): Promise<void> };
const prefix = "/_objects/tui/";
export function terminalFile(path: unknown, server: URL): string {
	const url = typeof path === "string" ? new URL(path, server) : undefined;
	if (
		!url ||
		url.origin !== server.origin ||
		url.search ||
		!/^\/_objects\/tui\/(?:plugin\/)?[\w.~@-]+$/.test(url.pathname)
	)
		throw new Error("terminal: no terminal file");
	return url.pathname;
}
const reset =
	"\x1b[?2026l\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?25h\x1b7\x1b[r\x1b8\x1b[?7h\x1b[?1049l\x1b[0m";
function ignoreSignal(): void {}
function locales(): readonly string[] {
	const { LANGUAGE, LC_ALL, LC_MESSAGES, LANG } = process.env;
	const tags = [...(LANGUAGE ?? "").split(":"), LC_ALL, LC_MESSAGES, LANG].flatMap((value) => {
		const tag = value?.replace(/[.@].*$/, "").replace(/_/g, "-");
		return !tag || tag === "C" || tag === "POSIX" ? [] : [tag];
	});
	return [...new Set([...tags, Intl.DateTimeFormat().resolvedOptions().locale])];
}
export async function startTerminal(options: TerminalOptions): Promise<RunningTerminal> {
	requireSandboxNode();
	const output = options.output ?? process.stdout,
		url = new URL(options.url),
		controller = new AbortController();
	const token = await tokenOf(
		options.credentials,
		url,
		(line) => {
			output.write(filterOutput(line) + "\r\n");
		},
		controller.signal,
	);
	const launcher = new Launcher(url, token, options);
	await launcher.start();
	return { exited: launcher.exited, stop: () => launcher.finish(0) };
}
class Launcher {
	readonly #url: URL;
	readonly #headers: { authorization: string };
	readonly #options: TerminalOptions;
	readonly #input: NonNullable<TerminalOptions["input"]>;
	readonly #output: NonNullable<TerminalOptions["output"]>;
	readonly #sockets = new Map<number, WebSocket>();
	readonly #done = Promise.withResolvers<number>();
	#sandbox?: Sandbox;
	#base = "";
	#finished = false;
	#requests = 0;
	#confirming = false;
	#held: string[] = [];
	#heldSize = 0;
	#interrupts: number[] = [];
	#prompt?: { lines: readonly string[]; resolve: (yes: boolean) => void; ready: number };
	get exited(): Promise<number> {
		return this.#done.promise;
	}
	get #columns(): number {
		return this.#output.columns || 80;
	}
	get #rows(): number {
		return this.#output.rows || 24;
	}
	constructor(url: URL, token: string, options: TerminalOptions) {
		this.#url = url;
		this.#headers = { authorization: "Bearer " + token };
		this.#options = options;
		this.#input = options.input ?? process.stdin;
		this.#output = options.output ?? process.stdout;
	}
	readonly #inputEvent = (data: Buffer | string): void => {
		const text = data.toString(),
			now = Date.now();
		for (const key of text) if (key === "\x03") this.#interrupts.push(now);
		this.#interrupts = this.#interrupts.filter((at) => now - at < 1000);
		if (this.#interrupts.length >= 3 || (this.#prompt && text.includes("\x03"))) {
			void this.finish(130);
			return;
		}
		if (!this.#prompt) this.#sandbox?.post({ kind: "input", data: text });
		else if (Date.now() >= this.#prompt.ready) this.#answerPrompt(text === "y" || text === "Y");
	};
	readonly #resize = (): void => {
		if (this.#prompt) this.#drawPrompt();
		this.#sandbox?.post({ kind: "resize", columns: this.#columns, rows: this.#rows });
	};
	readonly #exitEvent = (): void => {
		this.#output.write(reset);
		if (this.#input.isTTY) this.#input.setRawMode?.(false);
	};
	async start(): Promise<void> {
		await this.#launch();
		if (this.#input.isTTY) this.#input.setRawMode?.(true);
		this.#input.on("data", this.#inputEvent);
		this.#output.on("resize", this.#resize);
		process.once("exit", this.#exitEvent);
		if (process.platform !== "win32") process.on("SIGUSR1", ignoreSignal);
	}
	async finish(code: number): Promise<void> {
		if (this.#finished) return;
		this.#finished = true;
		this.#input.off("data", this.#inputEvent);
		this.#output.off("resize", this.#resize);
		process.off("exit", this.#exitEvent);
		if (process.platform !== "win32") process.off("SIGUSR1", ignoreSignal);
		if (this.#input.isTTY) this.#input.setRawMode?.(false);
		this.#prompt?.resolve(false);
		this.#prompt = undefined;
		this.#output.write(reset);
		this.#closeSockets();
		await this.#sandbox?.terminate();
		this.#done.resolve(code);
	}
	async #get(path: string): Promise<string> {
		const response = await fetch(new URL(path, this.#url), { headers: this.#headers });
		if (!response.ok || !response.body) throw new Error(`terminal: GET ${path} answered ${response.status}`);
		if (Number(response.headers.get("content-length") ?? 0) > MAX_BUNDLE)
			throw new Error(`terminal: ${path} exceeds 8 MiB`);
		let length = 0;
		const parts: Uint8Array[] = [];
		for await (const chunk of response.body) {
			length += chunk.length;
			if (length > MAX_BUNDLE) throw new Error(`terminal: ${path} exceeds 8 MiB`);
			parts.push(chunk);
		}
		return new TextDecoder().decode(Buffer.concat(parts));
	}
	async #launch(): Promise<void> {
		const start = JSON.parse(await this.#get(prefix + "start")) as TuiStart,
			[source, combined] = await Promise.all([this.#get(start.script), this.#get(start.combined)]);
		this.#base = start.base;
		this.#requests = 0;
		this.#sandbox = await Sandbox.start(
			source,
			{
				base: start.base,
				combined,
				columns: this.#columns,
				rows: this.#rows,
				colors: this.#options.colors ?? (/truecolor|24bit/.test(process.env.COLORTERM ?? "") ? "truecolor" : "256"),
				mode: this.#options.mode ?? "dark",
				locales: this.#options.locales ?? locales(),
			},
			(message) => {
				try {
					this.#handle(message);
				} catch {
					void this.finish(1);
				}
			},
			() => {
				void this.finish(1);
			},
		);
	}
	#handle(message: SandboxMessage): void {
		switch (message.kind) {
			case "write":
				this.#write(message.data);
				break;
			case "socket_open":
				this.#openSocket(message.socket);
				break;
			case "socket_close":
				this.#sockets.get(message.socket)?.close();
				break;
			case "socket_send": {
				const socket = this.#sockets.get(message.socket);
				if (socket?.readyState === WebSocket.OPEN) {
					if (socket.bufferedAmount + message.bytes.length > 16 * 1024 * 1024) socket.terminate();
					else socket.send(message.bytes);
				}
				break;
			}
			case "request":
				void this.#request(message.id, message.request);
				break;
			case "outdated":
				void this.#outdated();
				break;
			case "failed":
				this.#output.write("terminal: the terminal client failed to start\n");
				void this.finish(1);
				break;
			case "exit":
				void this.finish(message.code);
				break;
		}
	}
	#write(data: string): void {
		if (this.#confirming) {
			if (typeof data === "string" && this.#heldSize + data.length <= 1024 * 1024) {
				this.#held.push(data);
				this.#heldSize += data.length;
			}
			return;
		}
		try {
			this.#output.write(filterOutput(data));
		} catch {}
	}
	#openSocket(id: number): void {
		if (this.#sockets.size >= 4) {
			this.#sandbox?.post({ kind: "socket_closed", socket: id });
			return;
		}
		const url = new URL("/objects", this.#url);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const socket = new WebSocket(url, { headers: this.#headers });
		this.#sockets.set(id, socket);
		socket.on("open", () => this.#sandbox?.post({ kind: "socket_opened", socket: id }));
		socket.on("message", (data: Buffer) =>
			this.#sandbox?.post({ kind: "socket_message", socket: id, bytes: new Uint8Array(data) }),
		);
		const close = (): void => {
			if (this.#sockets.get(id) !== socket) return;
			this.#sockets.delete(id);
			this.#sandbox?.post({ kind: "socket_closed", socket: id });
		};
		socket.on("error", close);
		socket.on("close", close);
	}
	#closeSockets(): void {
		for (const socket of this.#sockets.values()) socket.close();
		this.#sockets.clear();
	}
	async #request(id: number, request: BridgeRequest): Promise<void> {
		const sandbox = this.#sandbox;
		if (!sandbox) return;
		if (this.#requests >= 8) {
			sandbox.post({ kind: "refused", id, message: "terminal: too many requests at once" });
			return;
		}
		this.#requests++;
		try {
			let value: unknown;
			if (request.kind === "fetch") value = await this.#get(terminalFile(request.path, this.#url));
			else if (request.kind === "base") value = JSON.parse(await this.#get(prefix + "base"));
			else if (request.kind === "attach") {
				const file = await this.#confirm(() => attach(request.path, this.#prompter()));
				if (file) {
					sandbox.post({ kind: "attached", id, name: file.name, bytes: file.bytes });
					return;
				}
				value = null;
			} else value = await this.#confirm(() => act(request, this.#prompter(), this.#options.opener));
			sandbox.post({ kind: "reply", id, value });
		} catch (error) {
			sandbox.post({ kind: "refused", id, message: error instanceof Error ? error.message : String(error) });
		} finally {
			if (this.#sandbox === sandbox) this.#requests--;
		}
	}
	async #confirm<T>(run: () => Promise<T>): Promise<T> {
		if (this.#confirming) throw new Error("terminal: a prompt is open");
		this.#confirming = true;
		try {
			return await run();
		} finally {
			this.#confirming = false;
			const held = this.#held;
			this.#held = [];
			this.#heldSize = 0;
			for (const data of held) this.#write(data);
			this.#resize();
		}
	}
	#prompter(): PromptTerminal {
		return {
			columns: this.#columns,
			write: (data) => {
				this.#output.write(data);
			},
			ask: (lines) => {
				if (promptLines(lines, this.#columns).length >= this.#rows)
					return Promise.reject(new Error("terminal: the prompt does not fit the terminal"));
				return new Promise((resolve) => {
					this.#prompt = { lines, resolve, ready: Date.now() + 300 };
					this.#drawPrompt();
				});
			},
		};
	}
	#drawPrompt(): void {
		const rows = promptLines(this.#prompt!.lines, this.#columns),
			top = Math.max(1, this.#rows - rows.length + 1);
		this.#output.write(
			"\x1b[?2026l\x1b[s" +
				rows.map((line, index) => `\x1b[${top + index};1H\x1b[0;30;47m\x1b[2K ${line} `).join("") +
				"\x1b[0m",
		);
	}
	#answerPrompt(yes: boolean): void {
		const prompt = this.#prompt!;
		this.#prompt = undefined;
		const rows = promptLines(prompt.lines, this.#columns),
			top = Math.max(1, this.#rows - rows.length + 1);
		this.#output.write(rows.map((_line, index) => `\x1b[${top + index};1H\x1b[0m\x1b[2K`).join("") + "\x1b[u");
		prompt.resolve(yes);
	}
	async #outdated(): Promise<void> {
		const base: unknown = JSON.parse(await this.#get(prefix + "base").catch(() => "null"));
		if (typeof base !== "string" || base === this.#base) return;
		this.#closeSockets();
		await this.#sandbox?.terminate();
		this.#sandbox = undefined;
		try {
			await this.#launch();
			this.#resize();
		} catch {
			await this.finish(1);
		}
	}
}
