import type { Context } from "../../context/index.ts";

export function sleep(ms: number, context: Context): Promise<void> {
	const signal = context.abortSignal;
	if (signal?.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout>;
		const abort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const schedule = (remaining: number): void => {
			const delay = Math.min(remaining, 2 ** 31 - 1);
			timer = setTimeout(() => {
				if (remaining > delay) schedule(remaining - delay);
				else {
					signal?.removeEventListener("abort", abort);
					resolve();
				}
			}, delay);
		};
		signal?.addEventListener("abort", abort, { once: true });
		schedule(ms);
	});
}

export function untilAborted(context: Context): Promise<void> {
	const signal = context.abortSignal;
	if (signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}
