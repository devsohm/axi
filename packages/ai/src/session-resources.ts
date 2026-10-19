export type SessionResourceCleanup = (sessionId?: string) => void;
const callbacks = new Set<SessionResourceCleanup>();
export function registerSessionResourceCleanup(cleanup: SessionResourceCleanup): () => void {
	callbacks.add(cleanup);
	return () => {
		callbacks.delete(cleanup);
	};
}
export function cleanupSessionResources(sessionId?: string): void {
	const errors: unknown[] = [];
	for (const callback of callbacks)
		try {
			callback(sessionId);
		} catch (error) {
			errors.push(error);
		}
	if (errors.length) throw new AggregateError(errors, "Failed to cleanup session resources");
}
