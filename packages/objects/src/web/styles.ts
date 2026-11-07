/// <reference lib="dom" />
import type { ClientError, ClientStyles, ScriptEntry, ScriptSet } from "../surfaces/index.ts";

type Outcome = "loaded" | "error" | "timeout" | "cancelled";
type Stylesheet = {
	link: HTMLLinkElement;
	url: string;
	state: "loading" | "loaded" | "error";
	listeners: AbortController;
	waits: Set<(outcome: Outcome) => void>;
};
function stylesheet(link: HTMLLinkElement, url: string, state: Stylesheet["state"]): Stylesheet {
	const sheet: Stylesheet = { link, url, state, listeners: new AbortController(), waits: new Set() };
	if (state === "loading")
		for (const event of ["load", "error"] as const) {
			link.addEventListener(
				event,
				() => {
					sheet.state = event === "load" ? "loaded" : "error";
					for (const done of [...sheet.waits]) done(sheet.state);
				},
				{ signal: sheet.listeners.signal },
			);
		}
	return sheet;
}
function remove(sheet: Stylesheet | undefined): void {
	if (sheet === undefined) return;
	sheet.listeners.abort();
	for (const done of [...sheet.waits]) done("cancelled");
	sheet.link.remove();
}
function wait(sheet: Stylesheet, signal: AbortSignal): Promise<Outcome> {
	if (signal.aborted) return Promise.resolve("cancelled");
	if (sheet.state !== "loading") return Promise.resolve(sheet.state);
	return new Promise((resolve) => {
		const finish = (result: Outcome) => {
			clearTimeout(timer);
			sheet.waits.delete(finish);
			signal.removeEventListener("abort", cancel);
			resolve(result);
		};
		const cancel = () => finish("cancelled");
		const timer = setTimeout(() => finish("timeout"), 10_000);
		sheet.waits.add(finish);
		signal.addEventListener("abort", cancel, { once: true });
	});
}

export class PageStyles implements ClientStyles {
	readonly #active = new Map<string, Stylesheet>();
	readonly #pending = new Map<string, Stylesheet>();
	readonly #report: (error: ClientError) => void;
	constructor(
		initial: Readonly<Record<string, string>>,
		ended: Readonly<Record<string, "load" | "error">>,
		report: (error: ClientError) => void,
	) {
		this.#report = report;
		const names = new Map(Object.entries(initial).map(([name, url]) => [url, name]));
		for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
			const url = link.getAttribute("href") ?? "",
				name = names.get(url);
			if (name !== undefined)
				this.#active.set(
					name,
					stylesheet(link, url, ended[url] === "load" ? "loaded" : ended[url] === "error" ? "error" : "loading"),
				);
		}
	}
	async prepare(set: ScriptSet, signal: AbortSignal): Promise<void> {
		const loads: Promise<void>[] = [];
		for (const [index, entry] of set.plugins.entries()) {
			const current = this.#active.get(entry.name),
				url = entry.css;
			if (url === undefined || (current?.url === url && current.state === "loaded")) {
				this.#discard(entry.name);
				continue;
			}
			let pending = this.#pending.get(entry.name);
			if (pending === undefined || pending.url !== url || pending.state === "error") {
				this.#discard(entry.name);
				const link = document.createElement("link");
				link.rel = "stylesheet";
				link.media = "not all";
				pending = stylesheet(link, url, "loading");
				link.href = url;
				this.#place(link, entry.name, set.plugins.slice(0, index), set.plugins.slice(index + 1));
				this.#pending.set(entry.name, pending);
			}
			loads.push(
				wait(pending, signal).then((result) => {
					if (result === "error" || result === "timeout")
						this.#report({ kind: "stylesheet_failed", plugin: entry.name, url, reason: result });
				}),
			);
		}
		await Promise.all(loads);
		if (signal.aborted) for (const name of [...this.#pending.keys()]) this.#discard(name);
	}
	settle(set: ScriptSet, kept: ReadonlySet<string>): void {
		const retired: Stylesheet[] = [],
			names = new Set(set.plugins.map((entry) => entry.name));
		for (const entry of set.plugins) {
			const old = this.#active.get(entry.name),
				next = this.#pending.get(entry.name);
			this.#pending.delete(entry.name);
			if (kept.has(entry.name)) remove(next);
			else if (next !== undefined) {
				next.link.removeAttribute("media");
				this.#active.set(entry.name, next);
				if (old !== undefined) retired.push(old);
			} else if (entry.css === undefined && old !== undefined) {
				retired.push(old);
				this.#active.delete(entry.name);
			}
		}
		for (const name of [...this.#pending.keys()]) this.#discard(name);
		for (const [name, sheet] of this.#active)
			if (!names.has(name)) {
				retired.push(sheet);
				this.#active.delete(name);
			}
		if (retired.length)
			setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => retired.forEach(remove))), 0);
	}
	#discard(name: string): void {
		remove(this.#pending.get(name));
		this.#pending.delete(name);
	}
	#place(link: HTMLLinkElement, name: string, before: readonly ScriptEntry[], after: readonly ScriptEntry[]): void {
		const own = this.#active.get(name);
		if (own !== undefined) {
			own.link.after(link);
			return;
		}
		for (let index = before.length - 1; index >= 0; index--) {
			const name = before[index]!.name,
				previous = this.#pending.get(name) ?? this.#active.get(name);
			if (previous !== undefined) {
				previous.link.after(link);
				return;
			}
		}
		for (const { name } of after) {
			const next = this.#active.get(name) ?? this.#pending.get(name);
			if (next !== undefined) {
				next.link.before(link);
				return;
			}
		}
		document.head.append(link);
	}
}
