import { asObjectsError, ObjectsError } from "./errors.ts";

export type FailureCause = {
	[K in "transient" | "broken" | "waiting"]: { readonly kind: K; readonly error: ObjectsError };
}["transient" | "broken" | "waiting"];
class BrokenConfiguration extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "BrokenOpen";
	}
}
export const broken = (cause: unknown): Error => new BrokenConfiguration(cause);
export function openFailure(value: unknown, label: string): FailureCause {
	return value instanceof BrokenConfiguration
		? { kind: "broken", error: asObjectsError(value.cause, label) }
		: { kind: "transient", error: asObjectsError(value, label) };
}
export function waitingFor(blocker: string, error: ObjectsError): FailureCause {
	let root = error.message;
	while (root.startsWith("waiting for ")) {
		const separator = root.indexOf(": ", 12);
		if (separator < 0) break;
		root = root.slice(separator + 2);
	}
	const shorten = (text: string, maximum: number) => text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
	if (blocker.length + root.length > 486) {
		root = shorten(root, Math.max(320, 486 - blocker.length));
		blocker = shorten(blocker, 486 - root.length);
	}
	const version = error.code === "contract_mismatch" || error.code === "unavailable" && error.reason === "version";
	return { kind: "waiting", error: new ObjectsError({ code: "unavailable", ...(version ? { reason: "version" } : {}), message: `waiting for ${blocker}: ${root}` }, { cause: error }) };
}
export function sameCause(a: FailureCause, b: FailureCause): boolean {
	return a.kind === b.kind && a.error.code === b.error.code && a.error.reason === b.error.reason && a.error.message === b.error.message;
}
