import { createContextKey, withContextValue, type Context } from "../context/index.ts";
import type { ObjectsObject } from "./object.ts";

export type OldWorkSource = { readonly draining: boolean };
export type CallNode = { readonly on: OldWorkSource; up(): CallNode | undefined };
export const CALL_CHAIN = createContextKey<CallNode>("objects.callChain");
export type Opening = { waitAt(target: ObjectsObject): () => void };
export const OPENING = createContextKey<Opening>("objects.opening");

export class OldWork {
	#active = 0;
	open(): void {
		this.#active++;
	}
	close(): void {
		this.#active--;
	}
	of(context: Context): boolean {
		if (!this.#active) return false;
		for (let call = context.value(CALL_CHAIN); call; call = call.up()) if (call.on.draining) return true;
		return false;
	}
}

const remote: CallNode = Object.freeze({ on: Object.freeze({ draining: true }), up: () => undefined });
export function asRemoteOldWork(context: Context): Context {
	return withContextValue(CALL_CHAIN, remote, context);
}
export function chainAttempts(context: Context): ReadonlySet<OldWorkSource> {
	const sources = new Set<OldWorkSource>();
	for (let call = context.value(CALL_CHAIN); call; call = call.up()) if (call !== remote) sources.add(call.on);
	return sources;
}
