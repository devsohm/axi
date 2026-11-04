import type { AnyContract, InputOf, Ref } from "./contract.ts";
import type { Op } from "./delta/index.ts";

export interface GetOptions<P = unknown> {
	readonly principal?: P;
	readonly state?: boolean;
}
export interface Ctx<P = unknown> {
	readonly signal: AbortSignal;
	readonly rootId: string;
	readonly codeVersion: number;
	readonly principal: P;
	get<C extends AnyContract>(type: C, input: InputOf<C>, options?: GetOptions<P>): Promise<Ref<C>>;
}
export type StateEvent<T> =
	| { readonly type: "snap"; readonly value: T }
	| { readonly type: "ops"; readonly ops: readonly Op[]; readonly value: T }
	| { readonly type: "reset"; readonly value: T };
export interface Readable<T> {
	readonly value: T;
	subscribe(listener: (value: T) => void): () => void;
	events(listener: (event: StateEvent<T>) => void): () => void;
}
export type StateSource<T> = Readable<T>;
declare const EXPOSED: unique symbol;
export interface Exposed<T> {
	readonly [EXPOSED]: T;
}
export type RefStatus = "loading" | "live" | "released" | "gone";
export interface Shape {
	readonly variant: string | undefined;
	readonly members: readonly string[];
	readonly contract: string;
}
export interface RefBase<C extends AnyContract> {
	readonly contract: C;
	readonly status: RefStatus;
	readonly ready: Promise<void>;
	readonly variant: string | undefined;
	readonly shape: Shape | undefined;
	readonly error: unknown;
	onShape(listener: (shape: Shape) => void): () => void;
	onStatus(listener: (status: RefStatus, error: unknown) => void): () => void;
	release(): void;
}
