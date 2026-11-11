import {
	createContext,
	createElement,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from "react";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../context/index.ts";
import type { Contract, EventMember, ParamsOf } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import { canonicalJson } from "../data/principal.ts";
import type { Held, Host, RefState } from "../host/index.ts";
import type { Registry } from "../registries/index.ts";
import { hostLanguage, type Messages, type Translator } from "../surfaces/index.ts";
import { pageState } from "../surfaces/page-state.ts";
import type { NativeWatchable, Watchable } from "../watch.ts";
import { watchStore } from "./stores.ts";

const HostContext = createContext<Host<Principal> | undefined>(undefined);
export function HostProvider<P extends Principal>({
	host,
	children,
}: {
	readonly host: Host<P>;
	readonly children?: ReactNode;
}) {
	return createElement(HostContext.Provider, { value: host as unknown as Host<Principal> }, children);
}
export function useHost<P extends Principal = Principal>(): Host<P> {
	const host = useContext(HostContext);
	if (!host) throw new Error("useHost: no HostProvider above this component");
	return host as unknown as Host<P>;
}
export function useHold<C extends Contract>(Type: C, params: ParamsOf<C>): Held<C> | undefined {
	const host = useHost(),
		key = canonicalJson(params as never, BACKGROUND_CONTEXT);
	const [current, set] = useState<{ key: string; ref: Held<C> }>();
	useEffect(() => {
		const ref = host.hold(Type, params, BACKGROUND_CONTEXT);
		set({ key, ref });
		return () => ref.release();
	}, [host, Type, key]);
	return current?.key === key ? current.ref : undefined;
}
export function useWatch<T>(source: Watchable<T> | NativeWatchable<T> | undefined): T | undefined {
	const store = useMemo(() => watchStore(source), [source]);
	return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}
export function useEvents<T>(
	member: EventMember<T> | undefined,
	listener: (event: { readonly value: T; readonly at: number }) => void,
): void {
	const current = useRef(listener);
	// Events flushed before passive effects must see the listener from the committed render.
	useLayoutEffect(() => {
		current.current = listener;
	});
	useEffect(() => {
		if (!member) return;
		const controller = new AbortController();
		void member
			.on((event) => current.current(event), withAbortSignal(controller.signal, BACKGROUND_CONTEXT))
			.catch(() => {});
		return () => controller.abort();
	}, [member]);
}
export function useRegistry<C, V>(registry: Registry<C, V>): V | undefined {
	const host = useHost(),
		[source, set] = useState<NativeWatchable<V>>();
	useEffect(() => {
		const controller = new AbortController();
		void host.registry(registry, withAbortSignal(controller.signal, BACKGROUND_CONTEXT)).then(set, () => {});
		return () => controller.abort();
	}, [host, registry]);
	return useWatch(source);
}
export function useRefState(ref: { readonly state: NativeWatchable<RefState> } | undefined): RefState | undefined {
	return useWatch(ref?.state);
}
export function usePageState<T>(key: string, initial: T): readonly [T, (value: T) => void] {
	const state = pageState(useHost(), key, initial);
	return [useSyncExternalStore(state.subscribe, state.read, state.read), state.set];
}
export function useMessages<N extends string, M>(
	messages: Messages<N, M>,
): { readonly t: Translator<N, M>; readonly locale: string | undefined } {
	const state = hostLanguage(useHost()),
		language = useSyncExternalStore(state.subscribe, state.read, state.read);
	return useMemo(() => ({ t: messages.in(language), locale: language?.locale }), [messages, language]);
}
