import { Value } from "typebox/value";
import { HYDRATION, type Hydration } from "./cell.ts";
import { type AnyContract, takesNoArgs } from "./contract.ts";
import { applyImmutable, type Decoder, decoder } from "./delta/index.ts";
import { ChordError, invalid } from "./errors.ts";
import {
	CtxImpl,
	notifyStatus,
	raceSignal,
	REF_BASE,
	type RefCore,
	type RefOwner,
	refsByProxy,
	type StatusListener,
} from "./object.ts";
import type { Ctx, Readable, RefStatus, Shape, StateEvent } from "./types.ts";
import { fromWireError, type RootRef, type WireError } from "./wire.ts";

export interface StateIn {
	readonly as: "snap" | "reset" | "ops" | "error";
	readonly value?: unknown;
	readonly ops?: readonly unknown[];
	readonly error?: WireError;
}
export interface RemoteChannel {
	hold(binding: RemoteBinding, again: boolean): number;
	release(id: number): void;
	call(hold: number, member: string, args: unknown, root: RootRef | undefined, signal: AbortSignal): Promise<unknown>;
	wantState(hold: number, wanted: boolean): void;
}
export interface RemoteHost {
	readonly inFactory: number;
	report(error: unknown): void;
	root<T>(fn: (ctx: Ctx) => T | Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
	bindingIdle(binding: RemoteBinding): void;
	forgetBinding(binding: RemoteBinding): void;
}
type Waiter = { resolve(): void; reject(error: unknown): void };
const noop = (): void => {};
function completion() {
	let resolve = noop;
	let reject: (error: unknown) => void = noop;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	promise.catch(noop);
	return { promise, resolve, reject };
}
type MemberState = { value: unknown; decoder: Decoder };
export class RemoteBinding {
	readonly host: RemoteHost;
	readonly key: string;
	readonly contract: AnyContract;
	readonly at: string;
	readonly input: unknown;
	readonly principal: unknown | undefined;
	status: "loading" | "live" | "ended" = "loading";
	error: unknown;
	shape: Shape | undefined;
	hydrated = false;
	hold: { readonly channel: RemoteChannel; readonly id: number } | undefined;
	stateOn = false;
	readonly views = new Set<RemoteRef>();
	readonly members = new Map<string, MemberState>();
	lingerTimer: ReturnType<typeof setTimeout> | undefined;
	readonly #listeners = new Map<string, Set<ViewReadable>>();
	readonly #hydration = new Set<Waiter>();
	#pending: { shape: Shape; readonly missing: Set<string>; readonly values: Map<string, MemberState> } | undefined;
	#live = completion();
	#applied = false;
	constructor(
		host: RemoteHost,
		fields: { key: string; contract: AnyContract; at: string; input: unknown; principal: unknown | undefined },
	) {
		this.host = host;
		this.key = fields.key;
		this.contract = fields.contract;
		this.at = fields.at;
		this.input = fields.input;
		this.principal = fields.principal;
	}
	get ended(): boolean {
		return this.status === "ended";
	}
	get applied(): boolean {
		return this.#applied;
	}
	get stateViews(): number {
		let count = 0;
		for (const view of this.views) if (view.wantsState) count++;
		return count;
	}
	get wantsState(): boolean {
		return this.views.size ? this.stateViews > 0 : this.stateOn;
	}
	addView(view: RemoteRef): void {
		this.views.add(view);
		if (this.lingerTimer !== undefined) {
			clearTimeout(this.lingerTimer);
			this.lingerTimer = undefined;
		}
		this.#sync();
		view.update();
	}
	removeView(view: RemoteRef): void {
		if (!this.views.delete(view)) return;
		for (const listeners of this.#listeners.values())
			for (const source of listeners) if (source.view === view) listeners.delete(source);
		if (!this.views.size) this.host.bindingIdle(this);
		else this.#sync();
	}
	#sync(): void {
		if (this.ended || !this.views.size) return;
		const wanted = this.stateViews > 0;
		if (wanted === this.stateOn) return;
		this.stateOn = wanted;
		if (!wanted) {
			this.hydrated = false;
			this.members.clear();
			this.#pending?.missing.clear();
		}
		if (this.hold) this.hold.channel.wantState(this.hold.id, wanted);
		for (const view of this.views) view.update();
	}
	listen(name: string, source: ViewReadable): void {
		let listeners = this.#listeners.get(name);
		if (!listeners) {
			listeners = new Set();
			this.#listeners.set(name, listeners);
		}
		listeners.add(source);
	}
	unlisten(name: string, source: ViewReadable): void {
		this.#listeners.get(name)?.delete(source);
	}
	inVariant(name: string): boolean {
		const variant = this.shape?.variant;
		return variant !== undefined && this.contract.description.variants[variant]?.[name]?.kind === "state";
	}
	readable(name: string): boolean {
		return !this.ended && this.hydrated && this.inVariant(name);
	}
	read(name: string): unknown {
		if (this.ended) throw this.terminalError();
		if (!this.hydrated) throw new ChordError("not_ready", `${this.key}.${name} is not hydrated yet`);
		if (!this.inVariant(name))
			throw new ChordError(
				"not_in_variant",
				`${this.key}: ${name} is not a state member of variant ${this.shape?.variant}`,
			);
		return this.members.get(name)?.value;
	}
	terminalError(): unknown {
		return this.error ?? new ChordError("released", `reference ${this.key} released`);
	}
	whenHydrated(): Promise<void> {
		if (this.hydrated) return Promise.resolve();
		if (this.ended) return Promise.reject(this.terminalError());
		return new Promise<void>((resolve, reject) => this.#hydration.add({ resolve, reject }));
	}
	#hydrated(error?: unknown): void {
		const waiters = [...this.#hydration];
		this.#hydration.clear();
		for (const waiter of waiters)
			if (error === undefined) waiter.resolve();
			else waiter.reject(error);
	}
	bound(channel: RemoteChannel, id: number): void {
		this.hold = { channel, id };
		this.stateOn = this.wantsState;
	}
	#stateMembers(shape: Shape): string[] {
		const members = shape.variant === undefined ? undefined : this.contract.description.variants[shape.variant];
		return members ? shape.members.filter((name) => members[name]?.kind === "state") : [];
	}
	shaped(shape: Shape, listed: readonly string[]): void {
		if (this.ended) return;
		const previous = this.#pending;
		const missing = new Set(listed);
		if (previous) for (const name of previous.missing) missing.add(name);
		const wanted = new Set(this.#stateMembers(shape));
		for (const name of [...missing]) if (!wanted.has(name) || !this.stateOn) missing.delete(name);
		this.#pending = { shape, missing, values: previous?.values ?? new Map() };
		if (!missing.size) this.#apply();
	}
	state(name: string, frame: StateIn): void {
		if (this.ended) return;
		if (frame.as === "error") {
			const error = fromWireError(frame.error!);
			if (!this.hydrated && this.stateOn) {
				this.gone(error);
				this.close();
			} else this.host.report(error);
			return;
		}
		const pending = this.#pending;
		if (frame.as === "ops") {
			const target = pending?.values.get(name) ?? this.members.get(name);
			if (!target) return;
			const ops = target.decoder.decode(frame.ops ?? []);
			target.value = applyImmutable(target.value, ops);
			if (target === this.members.get(name)) this.#deliver(name, { type: "ops", ops, value: target.value });
			return;
		}
		const state = { value: frame.value, decoder: decoder() };
		if (pending && (pending.missing.has(name) || pending.values.has(name))) {
			pending.values.set(name, state);
			pending.missing.delete(name);
			if (!pending.missing.size) this.#apply();
		} else if (this.inVariant(name)) {
			this.members.set(name, state);
			this.#deliver(name, { type: "reset", value: state.value });
		}
	}
	#apply(): void {
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = undefined;
		this.shape = pending.shape;
		const wanted = new Set(this.#stateMembers(pending.shape));
		for (const name of [...this.members.keys()]) if (!wanted.has(name)) this.members.delete(name);
		for (const [name, state] of pending.values) if (wanted.has(name)) this.members.set(name, state);
		this.hydrated = this.stateOn && [...wanted].every((name) => this.members.has(name));
		if (this.hydrated) this.#hydrated();
		this.status = "live";
		this.#applied = true;
		this.#live.resolve();
		for (const view of this.views) view.update();
		for (const [name, state] of pending.values)
			if (wanted.has(name)) this.#deliver(name, { type: "reset", value: state.value });
		for (const view of [...this.views]) view.shapeChanged();
	}
	#deliver(name: string, event: StateEvent<unknown>): void {
		const sources = this.#listeners.get(name);
		if (!sources) return;
		for (const source of [...sources]) source.deliver(event);
	}
	gone(error: unknown): void {
		if (this.ended) return;
		this.status = "ended";
		this.error = error;
		this.hold = undefined;
		this.#pending = undefined;
		this.#live.reject(error);
		this.#hydrated(error);
		for (const view of [...this.views]) view.end(error);
		this.#listeners.clear();
		this.host.forgetBinding(this);
	}
	detached(): void {
		if (this.ended) return;
		this.hold = undefined;
		this.#pending = undefined;
		if (this.status === "live") {
			this.status = "loading";
			this.#live = completion();
		}
		for (const view of this.views) view.update();
	}
	close(): void {
		if (this.lingerTimer !== undefined) clearTimeout(this.lingerTimer);
		this.lingerTimer = undefined;
		if (this.hold) this.hold.channel.release(this.hold.id);
		this.hold = undefined;
		if (!this.ended) {
			this.status = "ended";
			const error = new ChordError("released", `reference ${this.key} released`);
			this.#live.reject(error);
			this.#hydrated(error);
			for (const view of [...this.views]) view.end(error);
		}
		this.#pending = undefined;
		this.#listeners.clear();
		this.host.forgetBinding(this);
	}
	async call(name: string, args: unknown, ctx: Ctx): Promise<unknown> {
		while (true) {
			if (this.ended) throw this.terminalError();
			if (this.status !== "live" || !this.hold) await raceSignal(this.#live.promise, ctx.signal);
			const hold = this.hold;
			if (!hold || this.status !== "live") continue;
			const variant = this.shape?.variant;
			const method = variant === undefined ? undefined : this.contract.description.variants[variant]?.[name];
			if (method?.kind !== "method")
				throw new ChordError("not_in_variant", `${this.key}: ${name} is not a method of variant ${variant}`);
			const sent = method.args === undefined ? undefined : Value.Clean(method.args, Value.Clone(args));
			return hold.channel.call(hold.id, name, sent, { rootId: ctx.rootId, codeVersion: ctx.codeVersion }, ctx.signal);
		}
	}
}

class ViewReadable implements Readable<unknown> {
	readonly view: RemoteRef;
	readonly #name: string;
	readonly #values = new Set<(value: unknown) => void>();
	readonly #events = new Set<(event: StateEvent<unknown>) => void>();
	readonly #waiting = new Set<(event: StateEvent<unknown>) => void>();
	constructor(view: RemoteRef, name: string) {
		this.view = view;
		this.#name = name;
	}
	get value(): unknown {
		if (this.view.ended) throw this.view.terminalError();
		return this.view.binding.read(this.#name);
	}
	get [HYDRATION](): Hydration | undefined {
		const binding = this.view.binding;
		return binding.hydrated ? undefined : { hydrated: false, whenHydrated: () => binding.whenHydrated() };
	}
	#safe(fn: () => void): void {
		try {
			fn();
		} catch (error) {
			this.view.binding.host.report(error);
		}
	}
	#readable(): boolean {
		return !this.view.ended && this.view.binding.readable(this.#name);
	}
	#attach(): void {
		if (!this.view.ended) this.view.binding.listen(this.#name, this);
	}
	#detach(): void {
		if (!this.#values.size && !this.#events.size) this.view.binding.unlisten(this.#name, this);
	}
	subscribe(fn: (value: unknown) => void): () => void {
		this.#values.add(fn);
		this.#attach();
		if (this.#readable()) this.#safe(() => fn(this.view.binding.members.get(this.#name)?.value));
		return () => {
			this.#values.delete(fn);
			this.#detach();
		};
	}
	events(fn: (event: StateEvent<unknown>) => void): () => void {
		this.#events.add(fn);
		this.#attach();
		if (this.#readable())
			this.#safe(() => fn({ type: "snap", value: this.view.binding.members.get(this.#name)?.value }));
		else this.#waiting.add(fn);
		return () => {
			this.#events.delete(fn);
			this.#waiting.delete(fn);
			this.#detach();
		};
	}
	deliver(event: StateEvent<unknown>): void {
		for (const fn of [...this.#events]) {
			if (!this.#waiting.delete(fn)) this.#safe(() => fn(event));
			else if (event.type !== "ops") this.#safe(() => fn({ type: "snap", value: event.value }));
		}
		for (const fn of [...this.#values]) this.#safe(() => fn(event.value));
	}
	stop(): void {
		this.#values.clear();
		this.#events.clear();
		this.#waiting.clear();
		this.view.binding.unlisten(this.#name, this);
	}
}

export class RemoteRef implements RefCore {
	readonly object = undefined;
	readonly binding: RemoteBinding;
	readonly owner: RefOwner;
	readonly wantsState: boolean;
	readonly proxy: object;
	readonly ready: Promise<void>;
	status: RefStatus = "loading";
	error: unknown;
	readonly shapeListeners = new Set<(shape: Shape) => void>();
	readonly #statuses = new Set<StatusListener>();
	readonly #readables = new Map<string, ViewReadable>();
	readonly #callers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
	#ready: Waiter | undefined;
	constructor(binding: RemoteBinding, owner: RefOwner, wantsState: boolean) {
		this.binding = binding;
		this.owner = owner;
		this.wantsState = wantsState;
		const ready = completion();
		this.ready = ready.promise;
		this.#ready = ready;
		this.proxy = new Proxy(this, {
			get: (target, property) => {
				if (REF_BASE.has(property)) {
					const value: unknown = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				}
				return typeof property === "string" && property !== "then" ? target.member(property) : undefined;
			},
		});
		refsByProxy.set(this.proxy, this);
	}
	get contract(): AnyContract {
		return this.binding.contract;
	}
	get address(): string {
		return this.binding.key;
	}
	get ended(): boolean {
		return this.status === "gone" || this.status === "released";
	}
	get variant(): string | undefined {
		return this.binding.shape?.variant;
	}
	get shape(): Shape | undefined {
		return this.binding.shape;
	}
	onShape(fn: (shape: Shape) => void): () => void {
		this.shapeListeners.add(fn);
		return () => this.shapeListeners.delete(fn);
	}
	onStatus(fn: StatusListener): () => void {
		this.#statuses.add(fn);
		return () => this.#statuses.delete(fn);
	}
	#notify(): void {
		notifyStatus(this.#statuses, this.status, this.error, (error) => this.binding.host.report(error));
	}
	terminalError(): unknown {
		return this.status === "gone" ? this.error : new ChordError("released", `reference ${this.address} released`);
	}
	#stop(): void {
		for (const source of this.#readables.values()) source.stop();
	}
	release(): void {
		if (this.ended) return;
		this.status = "released";
		this.#notify();
		this.#ready?.reject(new ChordError("released", `reference ${this.address} released`));
		this.#ready = undefined;
		this.#stop();
		this.binding.removeView(this);
	}
	update(): void {
		if (this.ended) return;
		const live =
			this.binding.status === "live" && this.binding.hold !== undefined && (!this.wantsState || this.binding.hydrated);
		const next = live ? "live" : "loading";
		if (next === this.status) return;
		this.status = next;
		this.#notify();
		if (live) {
			this.#ready?.resolve();
			this.#ready = undefined;
		}
	}
	end(error: unknown): void {
		if (this.ended) return;
		const released = error instanceof ChordError && error.code === "released";
		this.status = released ? "released" : "gone";
		if (!released) this.error = error;
		this.#notify();
		this.#ready?.reject(error);
		this.#ready = undefined;
		this.#stop();
	}
	shapeChanged(): void {
		const shape = this.binding.shape;
		if (shape && !this.ended)
			for (const fn of [...this.shapeListeners]) {
				try {
					fn(shape);
				} catch (error) {
					this.binding.host.report(error);
				}
			}
	}
	member(name: string): unknown {
		const description = Object.values(this.contract.description.variants)
			.map((members) => members[name])
			.find((member) => member !== undefined);
		if (description?.kind === "method") return this.#caller(name);
		if (description?.kind !== "state") return undefined;
		let source = this.#readables.get(name);
		if (!source) {
			source = new ViewReadable(this, name);
			this.#readables.set(name, source);
		}
		return source;
	}
	#caller(name: string): (...args: unknown[]) => Promise<unknown> {
		let caller = this.#callers.get(name);
		if (!caller) {
			const noArgs = takesNoArgs(this.contract, name);
			caller = (...given) => {
				const [args, ctx] = noArgs ? [undefined, given[0]] : given,
					host = this.binding.host;
				if (host.inFactory > 0) throw new ChordError("not_ready", `${this.address}.${name} called inside a factory`);
				if (ctx !== undefined && !(ctx instanceof CtxImpl))
					return Promise.reject(invalid("foreign_ctx", "ctx must come from a Chord host"));
				try {
					ctx?.check(host);
				} catch (error) {
					return Promise.reject(error);
				}
				return ctx === undefined || ctx.holder
					? host.root((root) => this.#call(name, args, root), { signal: ctx?.signal })
					: this.#call(name, args, ctx);
			};
			this.#callers.set(name, caller);
		}
		return caller;
	}
	#call(name: string, args: unknown, ctx: Ctx): Promise<unknown> {
		return this.ended ? Promise.reject(this.terminalError()) : this.binding.call(name, args, ctx);
	}
}
