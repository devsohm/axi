import { getIdentityHeaders } from "../utils/identity.ts";
import type { ClassifierApi, ClassifierModel, ClassifierOptions } from "../types.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";

export async function classifierJson({
	label,
	url,
	model,
	body,
	options,
	apiKey,
	observe,
	noRetryStatuses,
}: {
	label: string;
	url: URL | string;
	model: ClassifierModel<ClassifierApi>;
	body: unknown;
	options?: ClassifierOptions;
	apiKey?: string;
	observe: boolean;
	noRetryStatuses?: readonly number[];
}): Promise<unknown> {
	const replacement = observe ? await options?.onPayload?.(body, model) : undefined;
	const payload = replacement === undefined ? body : replacement;
	const fetch = options?.fetch ?? globalThis.fetch;
	const key = apiKey ?? options?.apiKey;
	const requestHeaders = () =>
		providerHeadersToRecord(
			getIdentityHeaders(model, options?.identity),
			{ "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
			model.headers,
			options?.headers,
		) ?? {};
	const headers = model.api === "llama-cpp-classify" ? requestHeaders() : undefined;
	const { response, json } = await retryProviderRequest(
		async () => {
			const timeout = options?.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined;
			const signal =
				timeout && options?.signal ? AbortSignal.any([timeout, options.signal]) : (options?.signal ?? timeout);
			try {
				const response = await fetch(url, {
					method: "POST",
					headers: headers ?? requestHeaders(),
					body: JSON.stringify(payload),
					signal,
				});
				if (!response.ok)
					throw Object.assign(new Error(`${label} returned ${response.status}`), {
						status: response.status,
						headers: response.headers,
						body: await response.text(),
					});
				return { response, json: (await response.json()) as unknown };
			} catch (error) {
				if (timeout?.aborted && !options?.signal?.aborted)
					throw Object.assign(new Error(`Request timed out after ${options!.timeoutMs}ms`), {
						name: "TimeoutError",
						status: undefined,
						headers: undefined,
						body: "",
					});
				throw error;
			}
		},
		{
			maxRetries: options?.maxRetries ?? 2,
			maxRetryDelayMs: options?.maxRetryDelayMs,
			signal: options?.signal,
			noRetryStatuses,
		},
	);
	if (observe)
		await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
	return json;
}
