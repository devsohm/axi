export interface CombinedAbortSignal {
	signal?: AbortSignal;
	cleanup: () => void;
}
export function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): CombinedAbortSignal {
	const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	if (active.length < 2) return { ...(active[0] ? { signal: active[0] } : {}), cleanup() {} };
	const controller = new AbortController();
	const cleanup: (() => void)[] = [];
	for (const signal of active) {
		const abort = () => {
			if (!controller.signal.aborted) controller.abort(signal.reason);
		};
		if (signal.aborted) {
			abort();
			break;
		}
		signal.addEventListener("abort", abort, { once: true });
		cleanup.push(() => signal.removeEventListener("abort", abort));
	}
	return {
		signal: controller.signal,
		cleanup() {
			for (const remove of cleanup) remove();
		},
	};
}
