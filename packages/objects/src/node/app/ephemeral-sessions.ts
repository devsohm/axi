import type { Principal } from "../../data/index.ts";
export const EPHEMERAL_GRACE_MS = 60_000;
type Session = {
	readonly hash: string;
	readonly principal: Principal;
	links: number;
	timer?: ReturnType<typeof setTimeout>;
};
export class EphemeralSessions {
	readonly #sessions = new Map<string, Session>();
	readonly #max: number;
	readonly #grace: number;
	constructor(max: number, graceMs = EPHEMERAL_GRACE_MS) {
		this.#max = max;
		this.#grace = graceMs;
	}
	#expire(id: string, session: Session): void {
		session.timer = setTimeout(() => {
			if (!session.links) this.revoke(id);
		}, this.#grace);
		session.timer.unref?.();
	}
	issue(id: string, hash: string, principal: Principal): void {
		const session = { hash, principal, links: 0 };
		this.#sessions.set(id, session);
		this.#expire(id, session);
		for (const oldest of this.#sessions.keys()) {
			if (this.#sessions.size <= this.#max) break;
			this.revoke(oldest);
		}
	}
	get(id: string): { readonly hash: string; readonly principal: Principal } | undefined {
		return this.#sessions.get(id);
	}
	revoke(id: string): boolean {
		const session = this.#sessions.get(id);
		if (!session) return false;
		clearTimeout(session.timer);
		return this.#sessions.delete(id);
	}
	linkOpened(id: string): (() => void) | undefined {
		const session = this.#sessions.get(id);
		if (!session) return undefined;
		session.links++;
		clearTimeout(session.timer);
		session.timer = undefined;
		let closed = false;
		return () => {
			if (closed) return;
			closed = true;
			if (--session.links === 0 && this.#sessions.get(id) === session) this.#expire(id, session);
		};
	}
}
