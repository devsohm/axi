export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
export function describeError(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
