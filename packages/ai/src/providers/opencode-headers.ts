import type { ProviderStreams, StreamOptions } from "../types.ts";
function session<O extends StreamOptions>(options: O | undefined): O | undefined {
	if (
		!options?.sessionId ||
		Object.keys(options.headers ?? {}).some((name) => name.toLowerCase() === "x-opencode-session")
	)
		return options;
	return { ...options, headers: { ...options.headers, "x-opencode-session": options.sessionId } };
}
export function withOpenCodeSessionHeader(api: ProviderStreams): ProviderStreams {
	return {
		...api,
		stream: (model, context, options) => api.stream(model, context, session(options)),
		streamSimple: (model, context, options) => api.streamSimple(model, context, session(options)),
	};
}
