export function operationSignal(signal?: AbortSignal): AbortSignal {
	return signal ?? new AbortController().signal;
}
function reason(signal: AbortSignal): unknown {
	if (signal.reason !== undefined) return signal.reason;
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}
export function raceWithAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		void operation.catch(() => {});
		return Promise.reject(reason(signal));
	}
	return new Promise<T>((resolve, reject) => {
		let finished = false;
		function settle(action: () => void): void {
			if (finished) return;
			finished = true;
			signal.removeEventListener("abort", abort);
			action();
		}
		const abort = () => settle(() => reject(reason(signal)));
		signal.addEventListener("abort", abort, { once: true });
		void operation.then(
			(value) => settle(() => resolve(value)),
			(error) => settle(() => reject(error)),
		);
		if (signal.aborted) abort();
	});
}
