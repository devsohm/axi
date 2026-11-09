import { randomFillSync } from "node:crypto";
import type { Admitted } from "./admission.ts";
import type { Router } from "./router.ts";

export class AnswerHeaders {
	readonly #fields = new Map<string, readonly [string, readonly string[]]>();
	get(name: string): string | null {
		return this.#fields.get(name.toLowerCase())?.[1].join(", ") ?? null;
	}
	has(name: string): boolean {
		return this.#fields.has(name.toLowerCase());
	}
	delete(name: string): void {
		this.#fields.delete(name.toLowerCase());
	}
	set(name: string, value: string | readonly string[]): void {
		if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name))
			throw new TypeError(`header: invalid name ${JSON.stringify(name)}`);
		const values = typeof value === "string" ? [value] : value;
		for (const text of values)
			if (!/^[\t\x20-\x7e\x80-\xff]*$/.test(text))
				throw new TypeError(`header ${name}: invalid value ${JSON.stringify(text)}`);
		this.#fields.set(name.toLowerCase(), [name, values]);
	}
	*lines(): IterableIterator<readonly [string, string]> {
		for (const [name, values] of this.#fields.values()) for (const value of values) yield [name, value];
	}
}
export class Nonces {
	readonly #bytes = Buffer.allocUnsafe(4096);
	#cursor = 4096;
	next(): string {
		if (this.#cursor === this.#bytes.length) {
			randomFillSync(this.#bytes);
			this.#cursor = 0;
		}
		const value = this.#bytes.toString("base64", this.#cursor, this.#cursor + 16);
		this.#cursor += 16;
		return value;
	}
}
type Policy = readonly [string, string];
export class DefaultHeaders {
	readonly #cache = new WeakMap<Router, Map<string, Policy>>();
	of(admission: Admitted | undefined, router: Router | undefined, nonce: string): AnswerHeaders {
		const headers = new AnswerHeaders();
		headers.set("Cache-Control", "no-store");
		headers.set("X-Content-Type-Options", "nosniff");
		headers.set("Referrer-Policy", "no-referrer");
		if (!router?.framers.size && admission?.framer === undefined) headers.set("X-Frame-Options", "DENY");
		let policy: Policy;
		if (router && admission && admission.relay === undefined) {
			let origins = this.#cache.get(router);
			if (!origins) {
				origins = new Map();
				this.#cache.set(router, origins);
			}
			policy = origins.get(admission.origin) ?? makePolicy(admission, router);
			origins.set(admission.origin, policy);
		} else policy = makePolicy(admission, router);
		headers.set("Content-Security-Policy", `${policy[0]}${nonce}${policy[1]}`);
		return headers;
	}
}
function makePolicy(admission: Admitted | undefined, router: Router | undefined): Policy {
	const framers = [...(router?.framers ?? []), ...(admission?.framer === undefined ? [] : [admission.framer])];
	const directives = new Map<string, readonly string[]>([
		["default-src", ["'none'"]],
		["script-src", [...(admission && router?.scripts?.length ? router.scripts.map((path) => admission.origin + path) : ["'self'"]), "\0nonce\0"]],
		["connect-src", ["'self'", ...(admission ? [admission.origin.replace(/^http/, "ws")] : [])]],
		["base-uri", ["'none'"]],
		["form-action", ["'self'"]],
		["frame-ancestors", framers.length ? framers : ["'none'"]],
	]);
	for (const [name, values] of router?.csp ?? []) {
		const old = directives.get(name);
		directives.set(name, old && old[0] !== "'none'" ? [...old, ...values] : values);
	}
	const text = [...directives].map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
	const at = text.indexOf("\0nonce\0");
	return [`${text.slice(0, at)}'nonce-`, `'${text.slice(at + 7)}`];
}
