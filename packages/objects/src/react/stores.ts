import { BACKGROUND_CONTEXT, withAbortSignal } from "../context/index.ts";
import type { NativeWatchable, Watchable } from "../watch.ts";
export type ExternalStore<T> = {
	readonly subscribe: (changed: () => void) => () => void;
	readonly snapshot: () => T | undefined;
};
export function watchStore<T>(source: Watchable<T> | NativeWatchable<T> | undefined): ExternalStore<T> {
	return {
		snapshot() {
			try {
				return source?.value;
			} catch {
				return undefined;
			}
		},
		subscribe(changed) {
			if (!source) return () => {};
			const controller = new AbortController();
			void source.watch(withAbortSignal(controller.signal, BACKGROUND_CONTEXT)).then(
				(feed) => {
					feed.start(async () => {
						changed();
					});
					changed();
				},
				() => {},
			);
			return () => controller.abort();
		},
	};
}
