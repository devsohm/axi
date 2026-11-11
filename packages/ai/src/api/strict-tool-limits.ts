import { registerSessionResourceCleanup } from "../session-resources.ts";

const limited = new Set<string>();

export function isStrictToolLimitErrorMessage(message: string): boolean {
	return [
		"The compiled grammar is too large",
		"Too many strict tools (",
		"Schemas contains too many parameters with union types (",
	].some((phrase) => message.includes(phrase));
}

export function hasExceededStrictToolLimits(sessionId: string | undefined): boolean {
	return sessionId !== undefined && limited.has(sessionId);
}

export function markStrictToolLimitsExceeded(sessionId: string | undefined): void {
	if (sessionId === undefined) return;
	limited.add(sessionId);
	// Keep the fallback stable between turns; eviction only makes an old session retry strict tools once.
	if (limited.size > 10_000)
		for (const oldest of limited) {
			limited.delete(oldest);
			break;
		}
}

registerSessionResourceCleanup((sessionId) => {
	if (sessionId) limited.delete(sessionId);
	else limited.clear();
});
