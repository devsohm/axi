export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;
export interface NormalizedProviderError {
	status?: number;
	body?: string;
	message: string;
	messageCarriesBody: boolean;
}
function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
function plain(value: unknown): value is Record<string, unknown> {
	if (!object(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return (prototype === Object.prototype || prototype === null) && Object.keys(value).length > 0;
}
export function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
export function truncateErrorText(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}
export function normalizeProviderError(error: unknown): NormalizedProviderError {
	if (!(error instanceof Error)) return { message: safeJsonStringify(error), messageCarriesBody: false };
	const fields = error as Error & {
		statusCode?: unknown;
		status?: unknown;
		body?: unknown;
		error?: unknown;
		$metadata?: { httpStatusCode?: unknown };
		$response?: { statusCode?: unknown; body?: unknown };
	};
	let status: number | undefined;
	if (typeof fields.statusCode === "number") status = fields.statusCode;
	else if (typeof fields.status === "number") status = fields.status;
	else if (typeof fields.$metadata?.httpStatusCode === "number") status = fields.$metadata.httpStatusCode;
	else if (typeof fields.$response?.statusCode === "number") status = fields.$response.statusCode;
	let raw: string | undefined;
	if (typeof fields.body === "string") raw = fields.body;
	else if (plain(fields.error)) raw = safeJsonStringify(fields.error);
	else {
		const responseBody = fields.$response?.body;
		if (typeof responseBody === "string") raw = responseBody;
		else if (
			!(object(responseBody) && "pipe" in responseBody && typeof responseBody.pipe === "function") &&
			plain(responseBody)
		)
			raw = safeJsonStringify(responseBody);
	}
	const body = raw?.trim() ? truncateErrorText(raw.trim(), MAX_PROVIDER_ERROR_BODY_CHARS) : undefined;
	const messageCarriesBody = body === undefined || error.message.includes(body);
	return {
		status,
		body,
		message: error.message,
		messageCarriesBody,
	};
}
export function formatProviderError(error: NormalizedProviderError, prefix?: string): string {
	if (error.messageCarriesBody || error.status === undefined || error.body === undefined) {
		return prefix !== undefined && error.status !== undefined
			? `${prefix} (${error.status}): ${error.message}`
			: error.message;
	}
	return prefix === undefined ? `${error.status}: ${error.body}` : `${prefix} (${error.status}): ${error.body}`;
}
