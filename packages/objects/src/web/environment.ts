/// <reference lib="dom" />
import type { LoopEnvironment } from "../surfaces/index.ts";
export function pageEnvironment(): LoopEnvironment {
	return {
		now: () => Date.now(),
		online: () => navigator.onLine,
		after(ms, callback) {
			const timer = setTimeout(callback, ms);
			return () => clearTimeout(timer);
		},
		onWake(listener) {
			const restored = (event: PageTransitionEvent): void => {
				if (event.persisted) listener();
			};
			const visible = (): void => {
				if (document.visibilityState === "visible") listener();
			};
			const network = (navigator as Navigator & { connection?: EventTarget }).connection;
			window.addEventListener("online", listener);
			window.addEventListener("pageshow", restored);
			document.addEventListener("visibilitychange", visible);
			network?.addEventListener("change", listener);
			return () => {
				window.removeEventListener("online", listener);
				window.removeEventListener("pageshow", restored);
				document.removeEventListener("visibilitychange", visible);
				network?.removeEventListener("change", listener);
			};
		},
	};
}
