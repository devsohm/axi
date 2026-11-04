import { RegistryValueSource } from "../registries/internal.ts";
import { Constant, type NativeObserver } from "../state/internal.ts";

export type RetrySource = RegistryValueSource | Constant;
export function retrySource(source: unknown, label: string): RetrySource {
	if (source instanceof RegistryValueSource || source instanceof Constant) return source;
	throw new Error(`${label}: self.retryOn takes registry values and constants (sources that outlive the attempt)`);
}
export class RetryWakes {
	during: object | undefined;
	leaving = false;
	#subscriptions: {
		readonly source: RegistryValueSource;
		readonly observer: NativeObserver<unknown>;
	}[] = [];
	replace(sources: readonly RetrySource[], wake: () => void): void {
		this.stop();
		const observer: NativeObserver<unknown> = {
			advance(call) {
				if (call.kind === "value") wake();
			},
			end() {},
		};
		for (const source of sources)
			if (source instanceof RegistryValueSource) {
				source.subscribe(observer);
				this.#subscriptions.push({ source, observer });
			}
	}
	stop(): void {
		for (const { source, observer } of this.#subscriptions) source.unsubscribe(observer);
		this.#subscriptions = [];
	}
}
