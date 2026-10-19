import type { SetTimer } from "./types.ts";

const timerLimit = 2_147_483_647;
const workers = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
export const nativeTimer: SetTimer = (callback, delayMs, options) => {
	if (options.background && workers) return;
	let handle: ReturnType<typeof setTimeout>;
	const schedule = (remaining: number): ReturnType<typeof setTimeout> => {
		const timer = setTimeout(
			() => {
				if (remaining > timerLimit) handle = schedule(remaining - timerLimit);
				else callback();
			},
			Math.min(remaining, timerLimit),
		);
		if (options.background) (timer as { unref?: () => void }).unref?.();
		return timer;
	};
	handle = schedule(Math.max(0, delayMs));
	if (options.background && typeof (handle as { unref?: unknown }).unref !== "function") {
		clearTimeout(handle);
		return;
	}
	return () => clearTimeout(handle);
};
export type Timers = {
	foreground(callback: () => void, delayMs: number): () => void;
	background(callback: () => void, delayMs: number): (() => void) | undefined;
};
export function hostTimers(setTimer: SetTimer | undefined, report: (error: unknown) => void): Timers {
	const schedule = setTimer ?? nativeTimer;
	let reported = false;
	const once = (error: unknown): void => {
		if (!reported) {
			reported = true;
			report(error);
		}
	};
	return {
		foreground(callback, delayMs) {
			try {
				const cancel = schedule(callback, delayMs, { background: false });
				if (cancel !== undefined) return cancel;
				once(new Error("HarnessOptions.setTimer declined a timer that paces work; using setTimeout"));
			} catch (error) {
				once(error);
			}
			return nativeTimer(callback, delayMs, { background: false })!;
		},
		background(callback, delayMs) {
			try {
				return schedule(callback, delayMs, { background: true });
			} catch (error) {
				report(error);
				return;
			}
		},
	};
}
