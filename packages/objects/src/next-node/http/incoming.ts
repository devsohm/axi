export interface Incoming {
	readonly method: string;
	readonly url: string;
	header(name: string): string | null;
	forwarded(): boolean;
	cancelled(abort: (reason: unknown) => void): void;
	request(): Request;
}
export function isForwarding(name: string): boolean {
	return name === "forwarded" || name.startsWith("x-forwarded-");
}
export function webIncoming(request: Request): Incoming {
	return {
		method: request.method,
		url: request.url,
		header: (name) => request.headers.get(name),
		forwarded: () => [...request.headers.keys()].some(isForwarding),
		cancelled: (abort) => {
			if (request.signal.aborted) abort(request.signal.reason);
			else request.signal.addEventListener("abort", () => abort(request.signal.reason), { once: true });
		},
		request: () => request,
	};
}
