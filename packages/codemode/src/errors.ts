export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
export function describeError(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
export function scriptException(error: Pick<Error, "name" | "message" | "stack">): string {
	const title = error.message ? `${error.name}: ${error.message}` : error.name;
	const stack = error.stack?.trimEnd();
	return JSON.stringify({ name: error.name, message: error.message, stack: stack ? `${title}\n${stack}` : title });
}
