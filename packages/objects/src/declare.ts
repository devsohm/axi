import type { Ctx } from "./types.ts";

export interface Subscribable<E> {
	subscribe(listener: (event: E) => void): () => void;
}
export interface ResourceDeclaration<T> {
	readonly version: number;
	readonly deps?: readonly unknown[];
	readonly exclusive?: boolean;
	open(options: { readonly signal: AbortSignal }): T | Promise<T>;
	close?(value: T): void | Promise<void>;
}
export interface Resource<T> {
	readonly key: string;
	readonly value: T;
}
export interface ListenerDecl {
	readonly source: unknown;
	readonly select: ((value: never) => Subscribable<unknown>) | undefined;
	readonly fn: (event: unknown, ctx: Ctx) => void | Promise<void>;
}
export type ValueOf<S> = S extends Subscribable<unknown> ? S : S extends Resource<infer T> ? T : S;
export type EventOf<S> = S extends Subscribable<infer E> ? E : S extends Resource<infer T> ? EventOf<T> : never;
