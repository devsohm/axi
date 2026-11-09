export function oauthRequestSignal(signal: AbortSignal): AbortSignal {
	return AbortSignal.any([AbortSignal.timeout(30000), signal]);
}
export async function deviceForm(url: string, fields: Record<string, string>, signal: AbortSignal): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams(fields).toString(),
		signal: oauthRequestSignal(signal),
	});
}
export async function oauthJson(response: Response): Promise<Record<string, unknown> | null> {
	try {
		const value: unknown = await response.json();
		return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}
export function trustedOAuthUrl(value: unknown): string | null {
	if (typeof value !== "string" || !value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}
export function positiveOAuthNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
