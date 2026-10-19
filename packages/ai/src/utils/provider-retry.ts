import { operationSignal } from "./abort.ts";
import { sleep } from "./sleep.ts";

interface ProviderRetryOptions {
	maxRetries?: number;
	maxRetryDelayMs?: number;
	signal?: AbortSignal;
	noRetryStatuses?: readonly number[];
}
interface ProviderError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
}
function providerError(error: unknown): error is ProviderError {
	return (
		error instanceof Error &&
		"status" in error &&
		"headers" in error &&
		(error.status === undefined || typeof error.status === "number") &&
		(error.headers === undefined || error.headers instanceof Headers)
	);
}
function aborted(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}
function retryable(error: ProviderError): boolean {
	const header = error.headers?.get("x-should-retry");
	return (
		header === "true" ||
		(header !== "false" &&
			(error.status === undefined ||
				error.status === 408 ||
				error.status === 409 ||
				error.status === 429 ||
				(typeof error.status === "number" && error.status >= 500)))
	);
}
function delay(error: ProviderError, attempt: number, limit = 60_000): number {
	const millis = error.headers?.get("retry-after-ms");
	let value: number | undefined;
	if (millis) {
		const number = Number.parseFloat(millis);
		if (Number.isFinite(number)) value = number;
	}
	if (value === undefined) {
		const seconds = error.headers?.get("retry-after");
		if (seconds) {
			const number = Number.parseFloat(seconds);
			const parsed = Number.isNaN(number) ? Date.parse(seconds) - Date.now() : number * 1000;
			if (Number.isFinite(parsed)) value = parsed;
		}
	}
	if (value === undefined) return Math.min(0.5 * 2 ** attempt, 8) * 1000 * (1 - Math.random() * 0.25);
	if (limit > 0 && value > limit)
		throw new Error(
			`Server requested ${Math.ceil(value / 1000)}s retry delay (max: ${Math.ceil(limit / 1000)}s). ${error.message}`,
		);
	return value;
}
export async function retryProviderRequest<T>(
	request: () => Promise<T>,
	options: ProviderRetryOptions = {},
): Promise<T> {
	const maximum = options.maxRetries ?? 0;
	for (let attempt = 0; ; attempt++) {
		try {
			return await request();
		} catch (error) {
			if (options.signal?.aborted) throw aborted();
			if (
				attempt >= maximum ||
				!providerError(error) ||
				!retryable(error) ||
				(error.status !== undefined && options.noRetryStatuses?.includes(error.status))
			)
				throw error;
			const ms = delay(error, attempt, options.maxRetryDelayMs);
			try {
				await sleep(Math.max(0, ms), operationSignal(options.signal));
			} catch {
				throw aborted();
			}
		}
	}
}
