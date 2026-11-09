import type { ProviderHeaders } from "../types.ts";
export function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of headers.entries()) result[name] = value;
	return result;
}
export function providerHeadersToRecord(
	...sources: (ProviderHeaders | undefined)[]
): Record<string, string> | undefined {
	const entries = new Map<string, [string, string]>();
	for (const source of sources)
		for (const [name, value] of Object.entries(source ?? {})) {
			const key = name.toLowerCase();
			entries.delete(key);
			if (value !== null) entries.set(key, [name, value]);
		}
	return entries.size ? Object.fromEntries(entries.values()) : undefined;
}
