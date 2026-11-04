import type { Context } from "../context/index.ts";
import type { NativeWatchCall, WatchEnd } from "../watch.ts";

export interface NativeObserver<T> {
	advance(call: NativeWatchCall<T>, context: Context): void;
	end(end: WatchEnd): void;
}
export type NativeObservation<T> = { readonly value: T; detach(): void };
