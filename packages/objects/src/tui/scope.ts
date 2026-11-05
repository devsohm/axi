import { BACKGROUND_CONTEXT, withAbortSignal } from "../context/index.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import type { Held, Host } from "../host/index.ts";
import type { Registry } from "../registries/index.ts";
import { hostLanguage, type Messages, type Translator } from "../surfaces/index.ts";
import { pageState, type PageState } from "../surfaces/page-state.ts";
import type { NativeWatchable, Watchable } from "../watch.ts";

export class TuiScope<P extends Principal = Principal> {
	readonly #host: Host<P>;
	readonly #changed: () => void;
	readonly #abort = new AbortController();
	readonly #cleanup: (() => void)[] = [];
	constructor(host: Host<P>, changed: () => void) {
		this.#host = host;
		this.#changed = changed;
	}
	#context() {
		return withAbortSignal(this.#abort.signal, BACKGROUND_CONTEXT);
	}
	#notify(): void {
		if (!this.#abort.signal.aborted) this.#changed();
	}
	hold<C extends Contract>(Type: C, params: ParamsOf<C>): Held<C> {
		const held = this.#host.hold(Type, params, this.#context());
		this.#cleanup.push(() => held.release());
		this.watch(held.state);
		return held;
	}
	watch<T>(source: Watchable<T> | NativeWatchable<T>): () => T | undefined {
		void source.watch(this.#context()).then(
			(feed) => {
				feed.start(async () => this.#notify());
				this.#notify();
			},
			() => {},
		);
		return () => {
			try {
				return source.value;
			} catch {
				return undefined;
			}
		};
	}
	registry<C, V>(registry: Registry<C, V>): () => V | undefined {
		let read: () => V | undefined = () => undefined;
		void this.#host.registry(registry, this.#context()).then(
			(value) => {
				read = this.watch(value);
				this.#notify();
			},
			() => {},
		);
		return () => read();
	}
	optimistic<T>(read: () => T | undefined): readonly [read: () => T | undefined, show: <R>(value: T, call: Promise<R>) => Promise<R>] {
		let overlay: { value: T; count: number } | undefined;
		const finish = () => {
			if (overlay && --overlay.count === 0) overlay = undefined;
			this.#notify();
		};
		return [
			() => overlay ? overlay.value : read(),
			<R>(value: T, call: Promise<R>): Promise<R> => {
				overlay = { value, count: (overlay?.count ?? 0) + 1 };
				call.then(finish, finish);
				this.#notify();
				return call;
			},
		];
	}
	pageState<T>(key: string, initial: T): PageState<T> {
		const state = pageState(this.#host, key, initial);
		this.#cleanup.push(state.subscribe(() => this.#changed()));
		return state;
	}
	messages<N extends string, M>(messages: Messages<N, M>): Translator<N, M> {
		const state = hostLanguage(this.#host);
		this.#cleanup.push(state.subscribe(() => this.#changed()));
		let language = state.read(),
			bound = messages.in(language);
		const read = (): Translator<N, M> => {
			const next = state.read();
			if (language !== next) {
				language = next;
				bound = messages.in(next);
			}
			return bound;
		};
		const call: Translator<N, M> = Object.assign(
			<K extends keyof M & string>(key: K, ...args: import("../surfaces/messages.ts").MessageArgs<M[K]>) =>
				read()(key, ...args),
			{ render: (message: Parameters<Translator<N, M>["render"]>[0]) => read().render(message) },
		);
		return call;
	}
	dispose(): void {
		this.#abort.abort();
		for (const release of this.#cleanup.splice(0)) release();
	}
}
