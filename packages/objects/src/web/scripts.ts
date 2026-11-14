/// <reference lib="dom" />
import { REGISTER, type FacetFunction, type RegisteredScript, type ScriptEntry } from "../surfaces/index.ts";
export type PageBootstrap = {
	readonly base: string;
	readonly styles: Readonly<Record<string, string>>;
	readonly links: Readonly<Record<string, "load" | "error">>;
	readonly watching: (event: Event) => void;
	readonly queued: readonly (readonly [string, string, FacetFunction])[];
};
export class PageScripts {
	readonly base: string;
	readonly initial: readonly RegisteredScript[];
	readonly #pending = new Map<string, (script: RegisteredScript) => void>();
	constructor(bootstrap: PageBootstrap) {
		this.base = bootstrap.base;
		this.initial = bootstrap.queued.map(([plugin, digest, run]) => ({ plugin, digest, run }));
		Reflect.set(globalThis, REGISTER, (plugin: string, digest: string, run: FacetFunction) =>
			this.#pending.get(`${plugin}\0${digest}`)?.({ plugin, digest, run }),
		);
	}
	fetch(entry: ScriptEntry): Promise<RegisteredScript> {
		const key = `${entry.name}\0${entry.digest}`;
		return new Promise((resolve, reject) => {
			const element = document.createElement("script");
			const finish = (): void => {
				this.#pending.delete(key);
				element.remove();
			};
			this.#pending.set(key, (script) => {
				finish();
				resolve(script);
			});
			element.addEventListener("error", () => {
				finish();
				reject(new Error(`plugin "${entry.name}": its script ${entry.url} did not load`));
			});
			element.addEventListener("load", () => {
				if (this.#pending.has(key)) {
					finish();
					reject(new Error(`plugin "${entry.name}": ${entry.url} did not register ${entry.digest}`));
				}
			});
			element.src = entry.url;
			document.head.append(element);
		});
	}
}
