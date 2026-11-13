import type { Principal } from "../../data/index.ts";
export const EPHEMERAL_GRACE_MS = 60_000;
type SignIn = {
	readonly hash: string;
	readonly principal: Principal;
	links: number;
	timer?: ReturnType<typeof setTimeout>;
};
export class EphemeralSignIns {
	readonly #signIns = new Map<string, SignIn>();
	readonly #max: number;
	readonly #grace: number;
	constructor(max: number, graceMs = EPHEMERAL_GRACE_MS) {
		this.#max = max;
		this.#grace = graceMs;
	}
	#expire(id: string, signIn: SignIn): void {
		signIn.timer = setTimeout(() => {
			if (!signIn.links) this.revoke(id);
		}, this.#grace);
		signIn.timer.unref?.();
	}
	issue(id: string, hash: string, principal: Principal): void {
		const signIn = { hash, principal, links: 0 };
		this.#signIns.set(id, signIn);
		this.#expire(id, signIn);
		for (const oldest of this.#signIns.keys()) {
			if (this.#signIns.size <= this.#max) break;
			this.revoke(oldest);
		}
	}
	get(id: string): { readonly hash: string; readonly principal: Principal } | undefined {
		return this.#signIns.get(id);
	}
	revoke(id: string): boolean {
		const signIn = this.#signIns.get(id);
		if (!signIn) return false;
		clearTimeout(signIn.timer);
		return this.#signIns.delete(id);
	}
	linkOpened(id: string): (() => void) | undefined {
		const signIn = this.#signIns.get(id);
		if (!signIn) return undefined;
		signIn.links++;
		clearTimeout(signIn.timer);
		signIn.timer = undefined;
		let closed = false;
		return () => {
			if (closed) return;
			closed = true;
			if (--signIn.links === 0 && this.#signIns.get(id) === signIn) this.#expire(id, signIn);
		};
	}
}
