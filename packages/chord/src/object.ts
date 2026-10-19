import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	Cell,
	Derived,
	HYDRATION,
	type Hydration,
	hydrationOf,
	isSource,
	notReady,
	type Sources,
	type SourceValues,
	unhydrated,
} from "./cell.ts";
import {
	type Accepts,
	type Adapter,
	type AnyContract,
	bind,
	type ImplementationOf,
	type InputOf,
	LOCAL_VARIANT,
	type LocalContract,
	type MemberDescription,
	type Ref,
	takesNoArgs,
} from "./contract.ts";
import type { EventOf, ListenerDecl, Resource, ResourceDeclaration, Subscribable, ValueOf } from "./declare.ts";
import { asChordError, ChordError, invalid, runAll } from "./errors.ts";
import { enqueue } from "./publish.ts";
import type { Registration, Registry } from "./registry.ts";
import type { RemoteHost } from "./remote.ts";
import { assertValid, normalize } from "./schema.ts";
import type { Ctx, Exposed, GetOptions, Readable, RefStatus, Shape, StateEvent } from "./types.ts";

export interface ReferencedServeOptions {
	readonly lifetime?: "referenced";
	readonly linger?: number;
	readonly accepts?: Accepts;
}
export interface HostServeOptions {
	readonly lifetime: "host";
	readonly linger?: undefined;
	readonly accepts?: Accepts;
}
export type ServeOptions = ReferencedServeOptions | HostServeOptions;
export type ServeOptionsFor<C extends AnyContract> = C extends LocalContract
	? Record<never, never> extends InputOf<C>
		? ServeOptions
		: ReferencedServeOptions
	: ReferencedServeOptions;
export type Lifetime = "referenced" | "host";
export type Factory<C extends AnyContract, P = unknown> = (
	input: InputOf<C>,
	principal: P,
	self: Self<P>,
) => ImplementationOf<C, P>;
export interface Service {
	readonly contract: AnyContract;
	readonly factory: (input: unknown, principal: unknown, self: Self) => unknown;
	readonly options: ServeOptions;
	readonly facet: string;
}
export function makeService<C extends AnyContract>(
	contract: C,
	factory: Factory<C>,
	options: ServeOptions,
	facet: string,
): Service {
	const lifetime = options.lifetime ?? "referenced";
	if (lifetime !== "referenced" && lifetime !== "host")
		throw new TypeError(`${contract.name}: unknown lifetime ${String(lifetime)}`);
	if (lifetime === "host") {
		if (contract.scope !== "local")
			throw new TypeError(`${contract.name}: lifetime "host" needs a local type (remote types are referenced)`);
		if (options.linger !== undefined)
			throw new TypeError(
				`${contract.name}: an object of lifetime "host" does not linger (it lives as long as the host)`,
			);
		try {
			normalize(contract.input, {}, `${contract.name} input`);
		} catch {
			throw new TypeError(
				`${contract.name}: lifetime "host" needs an input that accepts {} (the object's one address)`,
			);
		}
	}
	return {
		contract,
		factory: factory as Service["factory"],
		options,
		facet,
	};
}
export const hostLifetime = (service: Service): boolean => service.options.lifetime === "host";
export interface StateOptions<T> {
	readonly version?: number;
	readonly migrate?: (old: unknown, from: number) => T;
}
export interface StateInit<T, P = unknown> {
	readonly init: (ctx: Ctx<P>) => T | Promise<T>;
}
export interface Self<P = unknown> {
	state<S extends TSchema>(
		name: string,
		schema: S,
		initial: Static<S> | StateInit<Static<S>, P>,
		options?: StateOptions<Static<S>>,
	): Cell<Static<S>>;
	get<C extends AnyContract>(type: C, input: InputOf<C>, options?: GetOptions<P>): Ref<C>;
	resource<T>(name: string, declaration: ResourceDeclaration<T>): Resource<T>;
	on<S>(name: string, source: S, handler: (event: EventOf<S>, ctx: Ctx<P>) => void | Promise<void>): void;
	on<S, E>(
		name: string,
		source: S,
		select: (value: ValueOf<S>) => Subscribable<E>,
		handler: (event: E, ctx: Ctx<P>) => void | Promise<void>,
	): void;
	task(fn: (ctx: Ctx<P>) => Promise<void>): void;
	derive<const S extends Sources, T>(sources: S, fn: (...values: SourceValues<S>) => T): Readable<T>;
	register<V>(registry: Registry<V>, entries: Readonly<Record<string, V>>): void;
	expose<T>(resource: Resource<T>): Exposed<T>;
}

export interface HostCore {
	readonly name: string;
	readonly dev: boolean;
	readonly principal: unknown;
	inFactory: number;
	readonly failed: unknown;
	readonly taskStopDeadline: number;
	readonly readyTimeout: number;
	report(error: unknown): void;
	currentCodeVersion(): number;
	hasCodeVersion(version: number): boolean;
	retainedCodeVersions(): Iterable<readonly [number, ReadonlyMap<string, Service>]>;
	pendingCodeVersion(): number | undefined;
	service(name: string): Service | undefined;
	acquire(
		type: AnyContract,
		input: unknown,
		options: GetOptions | undefined,
		owner: RefOwner,
		from?: ObjectImpl,
		candidate?: boolean,
	): RefCore;
	addressOf(type: AnyContract, input: unknown, principal: unknown, candidate?: boolean): string;
	root<T>(fn: (ctx: Ctx) => T | Promise<T>, options?: { codeVersion?: number; signal?: AbortSignal }): Promise<T>;
	touch(rootId: string, object: ObjectImpl): void;
	forget(object: ObjectImpl): void;
	disposed(object: ObjectImpl): void;
	checkRegistrations(object: ObjectImpl, decls: Decls): void;
	registriesChanged(including?: ObjectImpl): void;
}
const noop = (): void => {};
export function linkedSignal(sources: readonly AbortSignal[]): { readonly signal: AbortSignal; release(): void } {
	const controller = new AbortController(),
		removals: (() => void)[] = [];
	const release = (): void => {
		for (const remove of removals.splice(0)) remove();
	};
	for (const source of sources) {
		if (source.aborted) {
			release();
			controller.abort(source.reason);
			break;
		}
		const abort = (): void => {
			release();
			controller.abort(source.reason);
		};
		source.addEventListener("abort", abort, { once: true });
		removals.push(() => source.removeEventListener("abort", abort));
	}
	return { signal: controller.signal, release };
}
export async function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw new ChordError("aborted", "call aborted", { cause: signal.reason });
	let abort = noop;
	const cancellation = new Promise<never>((_, reject) => {
		abort = () => reject(new ChordError("aborted", "call aborted", { cause: signal.reason }));
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([promise, cancellation]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
export type RefOwner = "object" | "call" | "host" | "external" | "connection" | "client";
export interface RefCore {
	readonly address: string;
	readonly contract: AnyContract;
	readonly status: RefStatus;
	readonly ready: Promise<void>;
	readonly proxy: object;
	readonly object: ObjectImpl | undefined;
	release(): void;
}
export async function awaitReady(ref: RefCore, signals: readonly AbortSignal[], ms: number): Promise<void> {
	const deadline = new AbortController();
	const timer = Number.isFinite(ms)
		? setTimeout(
				() =>
					deadline.abort(
						new ChordError("unavailable", `${ref.address} was not ready after ${ms} ms`, { reason: "ready_timeout" }),
					),
				ms,
			)
		: undefined;
	timer?.unref?.();
	const linked = linkedSignal([...signals, deadline.signal]);
	try {
		await raceSignal(ref.ready, linked.signal);
	} catch (error) {
		ref.release();
		const reason: unknown = linked.signal.reason;
		throw reason instanceof ChordError && reason.reason === "ready_timeout" ? reason : error;
	} finally {
		clearTimeout(timer);
		linked.release();
	}
}
export class CtxImpl implements Ctx {
	readonly host: HostCore;
	readonly signal: AbortSignal;
	readonly rootId: string;
	readonly codeVersion: number;
	readonly principal: unknown;
	readonly holder: boolean;
	readonly #refs: RefCore[] = [];
	readonly #closing = new AbortController();
	readonly #unlink: () => void;
	#closed = false;
	constructor(
		host: HostCore,
		fields: {
			signals: readonly AbortSignal[];
			rootId: string;
			codeVersion: number;
			principal: unknown;
			holder?: boolean;
		},
	) {
		this.host = host;
		const linked = linkedSignal(fields.signals);
		this.signal = linked.signal;
		this.#unlink = linked.release;
		this.rootId = fields.rootId;
		this.codeVersion = fields.codeVersion;
		this.principal = fields.principal;
		this.holder = fields.holder ?? false;
	}
	get closed(): boolean {
		return this.#closed;
	}
	check(host: HostCore | RemoteHost): void {
		if (host !== this.host) throw invalid("foreign_ctx", "ctx belongs to another host");
		if (this.#closed) throw new ChordError("aborted", "ctx expired: its call already settled", { reason: "expired" });
		if (this.signal.aborted) {
			const reason: unknown = this.signal.reason;
			if (reason instanceof ChordError && reason.code === "superseded")
				throw new ChordError("superseded", reason.message, { cause: reason });
			throw new ChordError("aborted", "ctx aborted", { cause: reason });
		}
	}
	async get<C extends AnyContract>(type: C, input: InputOf<C>, options?: GetOptions): Promise<Ref<C>> {
		this.check(this.host);
		const ref = this.host.acquire(type, input, { principal: this.principal, ...options }, "call");
		this.#refs.push(ref);
		await awaitReady(ref, [this.signal, this.#closing.signal], this.host.readyTimeout);
		return ref.proxy as Ref<C>;
	}
	child(object: ObjectImpl): CtxImpl {
		return new CtxImpl(this.host, {
			signals: [this.signal, object.callAbort.signal],
			rootId: this.rootId,
			codeVersion: this.codeVersion,
			principal: this.host.principal,
		});
	}
	close(): void {
		this.#closed = true;
		this.#closing.abort(new ChordError("aborted", "ctx expired: its call already settled", { reason: "expired" }));
		this.#unlink();
		for (const ref of this.#refs.splice(0)) ref.release();
	}
}

export class ResourceImpl<T = unknown> implements Resource<T> {
	readonly key: string;
	spec: ResourceDeclaration<T>;
	readonly deps: readonly (RefCore | ResourceImpl)[];
	state: "closed" | "opening" | "open" | "unavailable" = "closed";
	#value: T | undefined;
	constructor(key: string, spec: ResourceDeclaration<T>, deps: readonly (RefCore | ResourceImpl)[]) {
		this.key = key;
		this.spec = spec;
		this.deps = deps;
	}
	get value(): T {
		if (this.state === "unavailable") throw new ChordError("unavailable", `resource ${this.key} could not be restored`);
		if (this.state !== "open") throw notReady(`resource ${this.key}`);
		return this.#value as T;
	}
	get exclusive(): boolean {
		return this.spec.exclusive === true;
	}
	async open(signal: AbortSignal, order: ResourceImpl[]): Promise<void> {
		if (this.state !== "closed") return;
		this.state = "opening";
		let value: T;
		try {
			value = await this.spec.open({ signal });
		} catch (error) {
			this.state = "closed";
			throw error;
		}
		if (signal.aborted) {
			this.state = "closed";
			await this.spec.close?.(value);
			throw new ChordError("aborted", `resource ${this.key} opened after abort`);
		}
		this.#value = value;
		this.state = "open";
		order.push(this);
	}
	async close(order: ResourceImpl[]): Promise<void> {
		if (this.state !== "open") return;
		this.state = "closed";
		const index = order.indexOf(this);
		if (index !== -1) order.splice(index, 1);
		const value = this.#value as T;
		this.#value = undefined;
		await this.spec.close?.(value);
	}
	markUnavailable(): void {
		this.state = "unavailable";
		this.#value = undefined;
	}
	adopt(spec: ResourceDeclaration<T>): void {
		this.spec = spec;
	}
}
const facades = new WeakMap<object, ResourceImpl>();
class ResourceFacade<T> implements Resource<T> {
	readonly #resource: ResourceImpl<T>;
	readonly #host: HostCore;
	constructor(resource: ResourceImpl<T>, host: HostCore) {
		this.#resource = resource;
		this.#host = host;
		facades.set(this, resource);
	}
	get key(): string {
		return this.#resource.key;
	}
	get value(): T {
		if (this.#host.inFactory > 0) throw notReady(`resource ${this.key} (inside a factory)`);
		return this.#resource.value;
	}
}
function resourceOf(value: unknown): ResourceImpl | undefined {
	return value instanceof ResourceImpl
		? value
		: value !== null && typeof value === "object"
			? facades.get(value)
			: undefined;
}
class ExposedResource {
	readonly resource: ResourceImpl;
	constructor(resource: ResourceImpl) {
		this.resource = resource;
	}
}
type Task = (ctx: Ctx) => Promise<void>;
export class Decls {
	readonly cells = new Map<string, Cell<unknown>>();
	readonly cellSchemas = new Map<string, TSchema>();
	readonly cellVersions = new Map<string, number>();
	readonly cellMigrations = new Map<string, (old: unknown, from: number) => unknown>();
	readonly refs = new Map<string, RefCore>();
	readonly resources = new Map<string, ResourceImpl>();
	readonly adopted = new Map<ResourceImpl, ResourceDeclaration<unknown>>();
	readonly listeners = new Map<string, ListenerDecl>();
	readonly tasks = new Map<string, Task>();
	readonly derives = new Map<string, Derived<unknown>>();
	readonly registrations = new Map<string, Registration>();
}
export interface Run {
	readonly implementation: Record<string, unknown>;
	readonly decls: Decls;
	readonly created: {
		readonly refs: RefCore[];
		readonly resources: ResourceImpl[];
		readonly derives: Derived<unknown>[];
		readonly inits: (readonly [Cell<unknown>, (ctx: Ctx) => unknown])[];
	};
}
export interface Installed {
	readonly codeVersion: number;
	readonly service: Service;
	readonly implementation: Record<string, unknown>;
	readonly decls: Decls;
}
export const refsByProxy = new WeakMap<object, RefCore>();
export const refOf = (value: unknown): RefCore | undefined =>
	value !== null && typeof value === "object" ? refsByProxy.get(value) : undefined;
export const REF_BASE: ReadonlySet<PropertyKey> = new Set([
	"contract",
	"status",
	"ready",
	"variant",
	"shape",
	"error",
	"onShape",
	"onStatus",
	"release",
]);
export type StatusListener = (status: RefStatus, error: unknown) => void;
export function notifyStatus(
	listeners: ReadonlySet<StatusListener>,
	status: RefStatus,
	error: unknown,
	report: (error: unknown) => void,
): void {
	if (listeners.size === 0) return;
	const snapshot = [...listeners];
	enqueue(() => {
		for (const fn of snapshot) {
			try {
				fn(status, error);
			} catch (cause) {
				report(cause);
			}
		}
	});
}
export const variantOf = (view: Record<string, unknown>): string | undefined =>
	typeof view.variant === "string" ? view.variant : undefined;
const readable = (value: unknown): value is Readable<unknown> =>
	value !== null &&
	typeof value === "object" &&
	typeof (value as Readable<unknown>).events === "function" &&
	typeof (value as Readable<unknown>).subscribe === "function";

class MemberReadable implements Readable<unknown> {
	readonly #ref: RefImpl;
	readonly #name: string;
	readonly #values = new Set<(value: unknown) => void>();
	readonly #events = new Set<(event: StateEvent<unknown>) => void>();
	readonly #waiting = new Set<(event: StateEvent<unknown>) => void>();
	#source: Readable<unknown> | undefined;
	#unsubscribe = noop;
	#last: { value: unknown } | undefined;
	constructor(ref: RefImpl, name: string) {
		this.#ref = ref;
		this.#name = name;
	}
	#current(): Readable<unknown> | undefined {
		const view = this.#ref.currentView();
		const value = view && this.#ref.inVariant(view, this.#name) ? view[this.#name] : undefined;
		return isSource(value) || readable(value) ? value : undefined;
	}
	get value(): unknown {
		if (this.#ref.status === "gone" || this.#ref.status === "released") throw this.#ref.terminalError();
		const view = this.#ref.currentView();
		if (this.#ref.status !== "live" || view === undefined) throw notReady(`${this.#ref.address}.${this.#name}`);
		const source = this.#current();
		if (!source)
			throw new ChordError(
				"not_in_variant",
				`${this.#ref.address}: ${this.#name} is not a state member of variant ${variantOf(view) ?? "(local)"}`,
			);
		return source.value;
	}
	get [HYDRATION](): Hydration | undefined {
		if (this.#ref.status === "live") return hydrationOf(this.#current());
		return {
			hydrated: false,
			whenHydrated: async () => {
				await this.#ref.ready;
				await hydrationOf(this.#current())?.whenHydrated();
			},
		};
	}
	#now(): Readable<unknown> | undefined {
		const source = this.#current();
		return hydrationOf(source)?.hydrated === false ? undefined : source;
	}
	#safe(fn: () => void): void {
		try {
			fn();
		} catch (error) {
			this.#ref.object.host.report(error);
		}
	}
	subscribe(fn: (value: unknown) => void): () => void {
		this.#values.add(fn);
		const source = this.#now();
		if (source) {
			this.#last = { value: source.value };
			this.#safe(() => fn(source.value));
		}
		this.bind();
		return () => {
			this.#values.delete(fn);
			this.bind();
		};
	}
	events(fn: (event: StateEvent<unknown>) => void): () => void {
		this.#events.add(fn);
		const source = this.#now();
		if (source) {
			const value = source.value;
			this.#last = { value };
			this.#safe(() => fn({ type: "snap", value }));
		} else this.#waiting.add(fn);
		this.bind();
		return () => {
			this.#waiting.delete(fn);
			this.#events.delete(fn);
			this.bind();
		};
	}
	bind(): void {
		const source = this.#values.size + this.#events.size ? this.#current() : undefined;
		if (source === this.#source) return;
		this.#unsubscribe();
		this.#unsubscribe = noop;
		this.#source = source;
		if (!source) return;
		let initial = true;
		this.#unsubscribe = source.events((event) => {
			const first = initial;
			initial = false;
			if (first && !this.#waiting.size && this.#last && event.value === this.#last.value) return;
			this.#last = { value: event.value };
			const translated: StateEvent<unknown> = first ? { type: "reset", value: event.value } : event;
			const events = [...this.#events],
				values = [...this.#values],
				waiting = new Set(this.#waiting);
			this.#waiting.clear();
			enqueue(() => {
				for (const fn of events)
					if (this.#events.has(fn))
						this.#safe(() => fn(waiting.has(fn) ? { type: "snap", value: event.value } : translated));
				for (const fn of values) if (this.#values.has(fn)) this.#safe(() => fn(event.value));
			});
		});
	}
	stop(): void {
		this.#values.clear();
		this.#events.clear();
		this.#waiting.clear();
		this.bind();
	}
}

export class RefImpl implements RefCore {
	readonly object: ObjectImpl;
	readonly contract: AnyContract;
	readonly owner: RefOwner;
	readonly address: string;
	readonly proxy: object;
	readonly ready: Promise<void>;
	status: RefStatus;
	error: unknown;
	readonly shapeListeners = new Set<(shape: Shape) => void>();
	readonly goneListeners = new Set<(error: unknown) => void>();
	readonly readables = new Map<string, MemberReadable>();
	readonly #statuses = new Set<StatusListener>();
	readonly #bindings = new WeakMap<Service, Adapter | undefined>();
	readonly #views = new WeakMap<Record<string, unknown>, Record<string, unknown>>();
	readonly #callers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
	constructor(object: ObjectImpl, contract: AnyContract, owner: RefOwner) {
		this.object = object;
		this.contract = contract;
		this.owner = owner;
		this.address = object.address;
		this.status = object.status === "live" ? "live" : "loading";
		this.ready = object.ready.then(() => {
			if (this.status === "gone" || this.status === "released") throw this.terminalError();
		});
		this.ready.catch(noop);
		this.proxy = new Proxy(this, {
			get: (target, property) => {
				if (REF_BASE.has(property)) {
					const value: unknown = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				}
				return typeof property === "string" && property !== "then" ? target.member(property) : undefined;
			},
			has: (target, property) => REF_BASE.has(property) || target.member(String(property)) !== undefined,
		});
		refsByProxy.set(this.proxy, this);
	}
	get variant(): string | undefined {
		const view = this.currentView();
		return view && variantOf(view);
	}
	get shape(): Shape | undefined {
		const installed = this.status === "live" ? this.object.currentInstalled() : undefined;
		const view = installed && this.#view(installed);
		return installed && view
			? {
					variant: variantOf(view),
					members: Object.keys(view).filter((key) => key !== "variant"),
					contract: installed.service.contract.fingerprint,
				}
			: undefined;
	}
	onShape(fn: (shape: Shape) => void): () => void {
		this.shapeListeners.add(fn);
		return () => this.shapeListeners.delete(fn);
	}
	onStatus(fn: StatusListener): () => void {
		this.#statuses.add(fn);
		return () => this.#statuses.delete(fn);
	}
	#status(): void {
		notifyStatus(this.#statuses, this.status, this.error, (error) => this.object.host.report(error));
	}
	#stop(): void {
		for (const source of this.readables.values()) source.stop();
	}
	release(): void {
		if (this.status === "released" || this.status === "gone") return;
		this.status = "released";
		this.#stop();
		this.#status();
		this.object.release(this);
	}
	live(): void {
		if (this.status === "loading") {
			this.status = "live";
			this.#status();
			this.shapeChanged();
		}
	}
	gone(error: unknown): void {
		if (this.status === "released" || this.status === "gone") return;
		this.status = "gone";
		this.error = error;
		this.#stop();
		this.#status();
		for (const fn of [...this.goneListeners]) fn(error);
	}
	terminalError(): unknown {
		return this.status === "gone" ? this.error : new ChordError("released", `reference ${this.address} released`);
	}
	shapeChanged(): void {
		for (const source of this.readables.values()) source.bind();
		const shape = this.shape;
		if (shape === undefined) return;
		const listeners = [...this.shapeListeners];
		enqueue(() => {
			for (const fn of listeners) {
				try {
					fn(shape);
				} catch (error) {
					this.object.host.report(error);
				}
			}
		});
	}
	viewOf(installed: Installed): Record<string, unknown> {
		if (!this.#bindings.has(installed.service))
			this.#bindings.set(
				installed.service,
				bind(installed.service.contract, installed.service.options.accepts, this.contract),
			);
		const adapter = this.#bindings.get(installed.service);
		if (!adapter) return installed.implementation;
		let view = this.#views.get(installed.implementation);
		if (!view) {
			view = adapter(installed.implementation);
			this.#views.set(installed.implementation, view);
		}
		return view;
	}
	#view(installed: Installed): Record<string, unknown> | undefined {
		try {
			return this.viewOf(installed);
		} catch (error) {
			this.object.host.report(error);
			return undefined;
		}
	}
	currentView(): Record<string, unknown> | undefined {
		const installed = this.status === "live" ? this.object.currentInstalled() : undefined;
		return installed && this.#view(installed);
	}
	describe(variant: string | undefined, name: string): MemberDescription | undefined {
		const variants = this.contract.description.variants;
		if (variant !== undefined) return variants[variant]?.[name];
		for (const members of Object.values(variants)) if (members[name] !== undefined) return members[name];
		return undefined;
	}
	inVariant(view: Record<string, unknown>, name: string): boolean {
		return this.contract.scope !== "remote" || this.describe(variantOf(view), name) !== undefined;
	}
	member(name: string): unknown {
		const declared = this.describe(undefined, name),
			view = this.currentView(),
			value = view?.[name];
		if (declared?.kind === "method" || (!declared && typeof value === "function")) return this.caller(name);
		if (declared?.kind === "state" || (!declared && readable(value))) {
			let source = this.readables.get(name);
			if (!source) {
				source = new MemberReadable(this, name);
				this.readables.set(name, source);
			}
			return source;
		}
		return view && this.inVariant(view, name)
			? value instanceof ExposedResource
				? value.resource.value
				: value
			: undefined;
	}
	caller(name: string): (...args: unknown[]) => Promise<unknown> {
		let caller = this.#callers.get(name);
		if (!caller) {
			const noArgs = takesNoArgs(this.contract, name);
			caller = (...given) => {
				const [args, ctx] = noArgs ? [undefined, given[0]] : given;
				if (this.object.host.inFactory)
					throw new ChordError("not_ready", `${this.address}.${name} called inside a factory`);
				if (ctx !== undefined && !(ctx instanceof CtxImpl))
					return Promise.reject(invalid("foreign_ctx", "ctx must come from a Chord host"));
				if (ctx === undefined || ctx.holder) {
					try {
						ctx?.check(this.object.host);
					} catch (error) {
						return Promise.reject(error);
					}
					return this.object.host.root((root) => this.object.call(this, name, args, root as CtxImpl), {
						signal: ctx?.signal,
					});
				}
				return this.object.call(this, name, args, ctx);
			};
			this.#callers.set(name, caller);
		}
		return caller;
	}
}

export type ObjectStatus = "activating" | "live" | "failed" | "disposing" | "disposed";
export interface ObjectIdentity {
	readonly address: string;
	readonly typeName: string;
	readonly input: unknown;
	readonly principal: unknown;
	readonly hostLifetime: boolean;
}
interface Gate {
	readonly grandfathered: Set<string>;
	readonly queue: { readonly key: string; readonly event: unknown }[];
	drained(): void;
}
interface Subscription {
	readonly origin: unknown;
	readonly select: ListenerDecl["select"];
	unsubscribe(): void;
}
export interface StagedListeners {
	activate(): void;
	discard(): void;
}

export class ObjectImpl {
	readonly host: HostCore;
	readonly address: string;
	readonly typeName: string;
	readonly input: unknown;
	readonly principal: unknown;
	readonly hostLifetime: boolean;
	status: ObjectStatus = "activating";
	ready: Promise<void> = Promise.resolve();
	service: Service | undefined;
	minCodeVersion = 0;
	decls = new Decls();
	readonly pending = new Set<Decls>();
	readonly implementations = new Map<number, Installed>();
	readonly refs = new Set<RefImpl>();
	readonly leases = new Map<string, number>();
	readonly openOrder: ResourceImpl[] = [];
	readonly callAbort = new AbortController();
	readonly activationAbort = new AbortController();
	gate: Gate | undefined;
	deferredRuntime = false;
	readonly #subscriptions = new Map<string, Subscription>();
	readonly #calls = new Set<Promise<unknown>>();
	readonly #tasks = new Map<string, { controller: AbortController; done: Promise<void> }>();
	readonly #stopped = new Set<Promise<void>>();
	#taskGeneration = 0;
	#linger: ReturnType<typeof setTimeout> | undefined;
	#disposal: Promise<void> | undefined;
	constructor(host: HostCore, identity: ObjectIdentity) {
		this.host = host;
		this.address = identity.address;
		this.typeName = identity.typeName;
		this.input = identity.input;
		this.principal = identity.principal;
		this.hostLifetime = identity.hostLifetime;
	}
	start(after?: Promise<void>): void {
		this.ready = this.#activate(after).then(
			() => {
				for (const ref of this.refs) ref.live();
				this.#idle();
			},
			(cause) => {
				if (this.status === "activating") this.status = "failed";
				this.host.forget(this);
				const error = asChordError(cause, `activating ${this.address}`);
				for (const ref of this.refs) ref.gone(error);
				throw error;
			},
		);
		this.ready.catch(noop);
	}
	async #activate(after?: Promise<void>): Promise<void> {
		await after?.catch(noop);
		const signal = this.activationAbort.signal;
		const check = (): void => {
			if (signal.aborted) throw new ChordError("aborted", `${this.address} abandoned`);
		};
		check();
		const service = this.host.service(this.typeName);
		if (!service) throw new ChordError("unavailable", `${this.typeName} is not served`, { reason: "unknown_type" });
		this.service = service;
		const run = this.run(service, undefined);
		try {
			await this.open(run.created.resources, run.created.refs, signal);
			check();
			await this.waitHydrated(run);
			check();
			await this.initCells(run, signal);
			check();
			this.host.checkRegistrations(this, run.decls);
			this.decls = run.decls;
			for (const [version, services] of this.host.retainedCodeVersions())
				if (services.get(this.typeName) === service)
					this.implementations.set(version, {
						codeVersion: version,
						service,
						implementation: run.implementation,
						decls: run.decls,
					});
			const pending = this.host.pendingCodeVersion();
			if (
				!this.implementations.has(this.host.currentCodeVersion()) &&
				(pending === undefined || !this.implementations.has(pending))
			)
				throw new ChordError("superseded", `${this.address}: code changed during activation`);
			for (const derived of run.created.derives) derived.attach();
			this.refreshSchemas();
			this.deferredRuntime = !this.implementations.has(this.host.currentCodeVersion());
			if (!this.deferredRuntime) {
				if (run.decls.registrations.size) this.host.registriesChanged(this);
				this.startRuntime();
			}
			check();
			this.status = "live";
		} catch (error) {
			this.callAbort.abort(error);
			this.stopListeners();
			this.stopTasks();
			const registered = this.decls.registrations.size > 0 && !this.deferredRuntime;
			this.implementations.clear();
			this.decls = new Decls();
			if (registered) this.host.registriesChanged();
			await Promise.allSettled([...this.#calls, ...this.#stopped]);
			await this.unwind(run).catch((cleanup) => this.host.report(cleanup));
			throw error;
		} finally {
			this.pending.delete(run.decls);
		}
	}
	run(service: Service, previous: Decls | undefined): Run {
		const self = new FactoryScope(this, previous),
			run = self.run(undefined);
		this.pending.add(run.decls);
		this.host.inFactory++;
		let value: unknown;
		try {
			value = service.factory(this.input, this.principal, self);
		} catch (error) {
			this.host.inFactory--;
			this.#discard(run);
			throw error;
		}
		this.host.inFactory--;
		const result = self.run(value);
		try {
			if (value instanceof Promise) throw invalid("implementation", `${this.typeName}: factories must be synchronous`);
			validateImplementation(service, result.implementation);
		} catch (error) {
			this.#discard(result);
			throw error;
		}
		return result;
	}
	#discard(run: Run): void {
		this.pending.delete(run.decls);
		void this.unwind(run).catch((error) => this.host.report(error));
	}
	async open(resources: readonly ResourceImpl[], refs: readonly RefCore[], signal: AbortSignal): Promise<void> {
		const pending = new Map<ResourceImpl, Promise<void>>();
		const open = (resource: ResourceImpl): Promise<void> => {
			let work = pending.get(resource);
			if (!work) {
				work = (async () => {
					await Promise.all(
						resource.deps.map((dep) =>
							dep instanceof ResourceImpl ? (resources.includes(dep) ? open(dep) : undefined) : dep.ready,
						),
					);
					await resource.open(signal, this.openOrder);
				})();
				pending.set(resource, work);
			}
			return work;
		};
		const ready = this.withinReadyTimeout(Promise.all(refs.map((ref) => ref.ready)), () =>
			refs.filter((ref) => ref.status === "loading").map((ref) => ref.address),
		);
		const results = await Promise.allSettled([...resources.map(open), ready]);
		const failure = results.find((result) => result.status === "rejected");
		if (failure) throw failure.reason;
	}
	async waitHydrated(run: Run): Promise<void> {
		const exposed = Object.entries(run.implementation),
			waiting = unhydrated([...run.created.derives, ...exposed.map(([, value]) => value)]);
		if (!waiting.length) return;
		await this.withinReadyTimeout(Promise.all(waiting.map((item) => item.whenHydrated())), () => [
			...exposed
				.filter(([, value]) => hydrationOf(value)?.hydrated === false)
				.map(([name]) => `${this.address}.${name}`),
			...run.created.derives
				.filter((source) => hydrationOf(source) !== undefined)
				.map((source) => `derive ${source.key}`),
		]);
	}
	async withinReadyTimeout<T>(work: Promise<T>, waiting: () => readonly string[]): Promise<T> {
		const ms = this.host.readyTimeout;
		if (!Number.isFinite(ms)) return work;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				const names = waiting();
				reject(
					new ChordError(
						"unavailable",
						`${this.address} was not ready after ${ms} ms${names.length ? `, waiting on ${names.join(", ")}` : ""} (a reference cycle across hosts?)`,
						{ reason: "ready_timeout" },
					),
				);
			}, ms);
			timer.unref?.();
		});
		timeout.catch(noop);
		try {
			return await Promise.race([work, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}
	async initCells(run: Run, signal: AbortSignal): Promise<void> {
		if (run.created.inits.length === 0) return;
		const results = await Promise.allSettled(
			run.created.inits.map(async ([cell, init]) => {
				const value = await this.host.root((ctx) => init(ctx), { signal });
				if (!signal.aborted) cell.initialize(value);
			}),
		);
		const failure = results.find((result) => result.status === "rejected");
		if (failure) throw failure.reason;
	}
	async unwind(run: Run): Promise<void> {
		for (const derived of run.created.derives) derived.detach();
		const resources = [...run.created.resources].sort((a, b) => this.openOrder.indexOf(b) - this.openOrder.indexOf(a));
		await runAll(
			[
				...resources.map((resource) => () => resource.close(this.openOrder)),
				...run.created.refs.map((ref) => () => ref.release()),
			],
			`${this.address}: cleanup failed`,
		);
	}
	currentInstalled(): Installed | undefined {
		return this.implementations.get(this.host.currentCodeVersion()) ?? [...this.implementations.values()].at(-1);
	}
	allDecls(): Set<Decls> {
		const declarations = new Set([this.decls, ...this.pending]);
		for (const installed of this.implementations.values()) declarations.add(installed.decls);
		return declarations;
	}
	refreshSchemas(): void {
		const schemas = new Map<Readable<unknown>, TSchema[]>();
		for (const installed of this.implementations.values())
			for (const [source, list] of memberSchemas(installed.service, installed.implementation))
				schemas.set(source, [...(schemas.get(source) ?? []), ...list]);
		for (const decls of this.allDecls())
			for (const source of [...decls.cells.values(), ...decls.derives.values()])
				source.schemas = schemas.get(source) ?? [];
	}
	stageListeners(decls: Decls): StagedListeners {
		type Fresh = Subscription & { buffer: unknown[] | undefined; start?: () => void };
		const fresh = new Map<string, Fresh>(),
			kept = new Set<string>();
		try {
			for (const [key, decl] of decls.listeners) {
				const origin = resourceOf(decl.source) ?? decl.source,
					old = this.#subscriptions.get(key);
				if (
					old &&
					old.origin === origin &&
					(old.select === decl.select ||
						(old.select !== undefined && decl.select !== undefined && String(old.select) === String(decl.select)))
				) {
					kept.add(key);
					continue;
				}
				const resource = resourceOf(decl.source);
				const value = resource === undefined ? decl.source : resource.value;
				const source = (decl.select ? decl.select(value as never) : value) as Subscribable<unknown>;
				if (typeof source?.subscribe !== "function")
					throw invalid("implementation", `listener ${key}: source has no subscribe()`);
				const entry: Fresh = { origin, select: decl.select, unsubscribe: noop, buffer: [] };
				fresh.set(key, entry);
				if (isSource(source) || readable(source)) {
					entry.buffer = undefined;
					entry.start = () => {
						entry.unsubscribe = source.subscribe((event) => this.#deliver(key, event));
					};
				} else
					entry.unsubscribe = source.subscribe((event) => {
						if (entry.buffer) entry.buffer.push(event);
						else this.#deliver(key, event);
					});
			}
		} catch (error) {
			for (const entry of fresh.values()) entry.unsubscribe();
			throw error;
		}
		return {
			activate: () => {
				for (const [key, entry] of this.#subscriptions)
					if (!kept.has(key)) {
						entry.unsubscribe();
						this.#subscriptions.delete(key);
					}
				for (const [key, entry] of fresh) {
					this.#subscriptions.set(key, entry);
					entry.start?.();
					const buffered = entry.buffer ?? [];
					entry.buffer = undefined;
					for (const event of buffered) this.#deliver(key, event);
				}
			},
			discard: () => {
				for (const entry of fresh.values()) entry.unsubscribe();
			},
		};
	}
	startRuntime(): void {
		this.stageListeners(this.decls).activate();
		this.startTasks();
	}
	stopListeners(): void {
		for (const entry of this.#subscriptions.values()) entry.unsubscribe();
		this.#subscriptions.clear();
	}
	startTasks(): void {
		const generation = ++this.#taskGeneration;
		const start = (): void => {
			for (const key of this.decls.tasks.keys()) this.#startTask(key);
		};
		if (!this.#stopped.size) {
			start();
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = this.host.taskStopDeadline;
		const timeout = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(true), deadline);
		});
		void Promise.race([Promise.allSettled([...this.#stopped]).then(() => false), timeout]).then((late) => {
			clearTimeout(timer);
			if (generation !== this.#taskGeneration || this.status !== "live") return;
			if (late)
				this.host.report(
					new ChordError(
						"aborted",
						`${this.address}: aborted tasks still running after ${deadline} ms; starting their replacements anyway`,
					),
				);
			start();
		});
	}
	#startTask(key: string): void {
		const fn = this.decls.tasks.get(key);
		if (!fn) return;
		const controller = new AbortController();
		const ctx = new CtxImpl(this.host, {
			signals: [controller.signal, this.callAbort.signal],
			rootId: `task:${this.address}:${key}`,
			codeVersion: this.host.currentCodeVersion(),
			principal: this.host.principal,
			holder: true,
		});
		const done = (async () => {
			try {
				await fn(ctx);
			} catch (error) {
				if (!ctx.signal.aborted) this.host.report(error);
			} finally {
				ctx.close();
				if (this.#tasks.get(key)?.controller === controller) this.#tasks.delete(key);
			}
		})();
		this.#tasks.set(key, { controller, done });
	}
	stopTasks(): void {
		this.#taskGeneration++;
		for (const task of this.#tasks.values()) {
			task.controller.abort(new ChordError("aborted", "task stopped"));
			this.#stopped.add(task.done);
			void task.done.finally(() => this.#stopped.delete(task.done));
		}
		this.#tasks.clear();
	}
	#deliver(key: string, event: unknown): void {
		enqueue(() => {
			if (this.gate) {
				this.gate.queue.push({ key, event });
				return;
			}
			const decl = this.decls.listeners.get(key);
			if (!decl || (this.status !== "live" && this.status !== "activating")) return;
			void this.host
				.root((root) => {
					this.lease(root);
					const ctx = (root as CtxImpl).child(this);
					return this.#invoke(async () => {
						try {
							await decl.fn(event, ctx);
						} finally {
							ctx.close();
						}
					});
				})
				.catch((error) => this.host.report(error));
		});
	}
	openGate(): void {
		const queued = this.gate?.queue ?? [];
		this.gate = undefined;
		for (const { key, event } of queued) this.#deliver(key, event);
	}
	admit(ctx: Ctx): void {
		if (this.host.failed !== undefined)
			throw new ChordError("unavailable", `${this.host.name} failed and admits no work`, { reason: "host_failed" });
		if (!this.host.hasCodeVersion(ctx.codeVersion))
			throw new ChordError("superseded", `code version ${ctx.codeVersion} is retired`);
		if (ctx.codeVersion < this.minCodeVersion)
			throw new ChordError("upgrade_conflict", `${this.address} was upgraded in code version ${this.minCodeVersion}`);
		if (this.gate && !this.gate.grandfathered.has(ctx.rootId))
			throw new ChordError("upgrade_conflict", `${this.address} is being upgraded`);
	}
	lease(ctx: Ctx): void {
		if (!this.leases.has(ctx.rootId)) {
			this.leases.set(ctx.rootId, ctx.codeVersion);
			this.host.touch(ctx.rootId, this);
		}
	}
	readonly guard = (ctx: Ctx): void => {
		if (this.host.inFactory) throw invalid("read_only", "cells cannot be written while a factory runs");
		if (ctx instanceof CtxImpl) ctx.check(this.host);
		if (ctx.signal.aborted) throw new ChordError("aborted", "write with an aborted ctx");
		if (this.status === "disposed") throw new ChordError("gone", `${this.address} is disposed`);
		if (!ctx.rootId.startsWith("task:")) this.admit(ctx);
	};
	async call(ref: RefImpl, name: string, args: unknown, ctx: CtxImpl): Promise<unknown> {
		ctx.check(this.host);
		if (ref.status === "released" || ref.status === "gone") throw ref.terminalError();
		if (ref.status === "loading") await raceSignal(ref.ready, ctx.signal);
		if (ref.status !== "live" || this.status !== "live")
			throw ref.status === "live" ? new ChordError("gone", `${this.address} is ${this.status}`) : ref.terminalError();
		this.admit(ctx);
		const installed = this.implementations.get(ctx.codeVersion);
		if (!installed)
			throw new ChordError("superseded", `${this.address} has no implementation for code version ${ctx.codeVersion}`);
		const view = ref.viewOf(installed),
			variant = variantOf(view);
		const wanted = ref.describe(ref.contract.scope === "remote" ? variant : LOCAL_VARIANT, name);
		const fn = view[name];
		if (typeof fn !== "function" || (ref.contract.scope === "remote" && wanted?.kind !== "method"))
			throw new ChordError(
				"not_in_variant",
				`${this.address}: ${name} is not a method of variant ${variant ?? "(local)"}`,
			);
		const description =
			view === installed.implementation
				? installed.service.contract.description.variants[variant ?? LOCAL_VARIANT]?.[name]
				: wanted;
		const method = description?.kind === "method" ? description : undefined;
		const validated = ref.contract.scope === "remote" ? method : undefined;
		const takesArgs = method === undefined || method.args !== undefined,
			returns = method === undefined || method.result !== undefined;
		let input: unknown;
		if (takesArgs) {
			const own = ref.contract.scope === "remote" && wanted?.kind === "method" ? wanted.args : undefined;
			const sent = own ? Value.Clean(own, Value.Clone(args)) : args;
			input = validated?.args ? Value.Clean(validated.args, Value.Clone(sent)) : sent;
			if (validated?.args) assertValid("args", `${this.address}.${name} args`, validated.args, input);
		}
		this.lease(ctx);
		const child = ctx.child(this);
		let result: unknown;
		try {
			result = await this.#invoke(() => (takesArgs ? fn(input, child) : fn(child)));
		} finally {
			child.close();
		}
		if (!returns) return undefined;
		if (validated?.result) assertValid("result", `${this.address}.${name} result`, validated.result, result);
		return result;
	}
	#invoke<T>(fn: () => T | Promise<T>): Promise<T> {
		const promise = (async () => fn())();
		this.#calls.add(promise);
		const settled = (): void => {
			this.#calls.delete(promise);
			if (!this.#calls.size) this.#idle();
		};
		promise.then(settled, settled);
		return promise;
	}
	rootEnded(rootId: string): void {
		this.leases.delete(rootId);
		if (this.gate?.grandfathered.delete(rootId) && !this.gate.grandfathered.size) this.gate.drained();
	}
	addRef(ref: RefImpl): void {
		this.refs.add(ref);
		clearTimeout(this.#linger);
		this.#linger = undefined;
	}
	release(ref: RefImpl): void {
		if (this.refs.delete(ref)) this.#idle();
	}
	#idle(): void {
		if (this.refs.size || this.#calls.size || this.#linger !== undefined) return;
		const dispose = (): void => {
			void this.dispose(false).catch((error) => this.host.report(error));
		};
		if (this.status === "activating") {
			dispose();
			return;
		}
		if (this.status !== "live") return;
		const linger = this.service?.options.linger ?? 0;
		if (linger <= 0) {
			dispose();
			return;
		}
		this.#linger = setTimeout(() => {
			this.#linger = undefined;
			if (!this.refs.size && !this.#calls.size && this.status === "live") dispose();
		}, linger);
		this.#linger.unref?.();
	}
	dispose(forced: boolean, reason?: unknown): Promise<void> {
		return (this.#disposal ??= this.#dispose(forced, reason));
	}
	async #dispose(forced: boolean, reason: unknown): Promise<void> {
		const activating = this.status === "activating";
		this.status = "disposing";
		this.host.forget(this);
		clearTimeout(this.#linger);
		this.#linger = undefined;
		const error = reason ?? new ChordError("gone", `${this.address} was disposed`);
		if (forced) {
			for (const ref of this.refs) ref.gone(error);
			this.callAbort.abort(error);
		}
		this.activationAbort.abort(error);
		if (activating) await this.ready.catch(noop);
		for (const ref of this.refs) ref.gone(error);
		const decls = this.allDecls();
		this.stopTasks();
		this.stopListeners();
		await Promise.allSettled([...this.#calls]);
		const registered = !this.deferredRuntime && [...decls].some((decl) => decl.registrations.size > 0);
		this.implementations.clear();
		this.decls = new Decls();
		if (registered) this.host.registriesChanged();
		const refs = new Set<RefCore>();
		for (const decl of decls) {
			for (const derived of decl.derives.values()) derived.detach();
			for (const ref of decl.refs.values()) refs.add(ref);
		}
		try {
			await runAll(
				[
					() => Promise.allSettled([...this.#stopped]),
					...[...this.openOrder].reverse().map((resource) => () => resource.close(this.openOrder)),
					...[...refs].map((ref) => () => ref.release()),
				],
				`${this.address}: disposal failed`,
			);
		} finally {
			this.status = "disposed";
			this.host.disposed(this);
		}
	}
}

export function memberSchemas(
	service: Service,
	implementation: Record<string, unknown>,
): Map<Readable<unknown>, TSchema[]> {
	const schemas = new Map<Readable<unknown>, TSchema[]>();
	if (service.contract.scope !== "remote") return schemas;
	for (const [key, description] of Object.entries(
		service.contract.description.variants[variantOf(implementation) ?? ""] ?? {},
	)) {
		const source = implementation[key];
		if (description.kind === "state" && isSource(source))
			schemas.set(source, [...(schemas.get(source) ?? []), description.schema]);
	}
	return schemas;
}
function validateImplementation(service: Service, view: Record<string, unknown>): void {
	const contract = service.contract;
	const fail = (message: string): never => {
		throw invalid("implementation", `${contract.name}: ${message}`);
	};
	if (view === null || typeof view !== "object") fail("factory must return an object");
	let members: Readonly<Record<string, MemberDescription>>;
	if (contract.scope === "remote") {
		const variant = view.variant;
		if (typeof variant !== "string" || contract.description.variants[variant] === undefined)
			fail(`unknown variant ${String(variant)}`);
		members = contract.description.variants[variant as string];
		for (const key of Object.keys(view))
			if (key !== "variant" && members[key] === undefined) fail(`${key} is not in variant ${String(variant)}`);
	} else members = contract.description.variants[LOCAL_VARIANT] ?? {};
	for (const [key, description] of Object.entries(members)) {
		const value = view[key];
		if (description.kind === "method" && typeof value !== "function") fail(`${key} must be a method`);
		if (description.kind === "state" && !isSource(value) && !readable(value))
			fail(`${key} must be a cell, a derivation or a held object's state member`);
		if (description.kind === "opaque" && value === undefined) fail(`${key} is missing`);
	}
}

class FactoryScope implements Self {
	readonly #object: ObjectImpl;
	readonly #previous: Decls | undefined;
	readonly #decls = new Decls();
	readonly #created: Run["created"] = { refs: [], resources: [], derives: [], inits: [] };
	constructor(object: ObjectImpl, previous: Decls | undefined) {
		this.#object = object;
		this.#previous = previous;
	}
	run(implementation: unknown): Run {
		return { implementation: implementation as Record<string, unknown>, decls: this.#decls, created: this.#created };
	}
	#unique(map: ReadonlyMap<string, unknown>, kind: string, name: string): void {
		if (typeof name !== "string" || !name) throw new TypeError(`${kind} needs a name`);
		if (map.has(name)) throw invalid("duplicate", `${this.#object.typeName}: duplicate ${kind} name ${name}`);
	}
	state<S extends TSchema>(
		name: string,
		schema: S,
		initial: Static<S> | StateInit<Static<S>>,
		options: StateOptions<Static<S>> = {},
	): Cell<Static<S>> {
		this.#unique(this.#decls.cells, "state", name);
		const version = options.version ?? 1;
		if (!Number.isInteger(version) || version < 1)
			throw new TypeError(`state ${name}: version must be a positive integer`);
		const init =
			initial !== null && typeof initial === "object" && typeof (initial as StateInit<unknown>).init === "function"
				? (initial as StateInit<unknown>).init
				: undefined;
		let cell = this.#previous?.cells.get(name);
		if (!cell) {
			const host = this.#object.host;
			cell = new Cell<unknown>(name, schema, init ? undefined : { value: initial }, this.#object.guard, {
				dev: host.dev,
				report: (error) => host.report(error),
			});
			if (init) this.#created.inits.push([cell, init]);
		}
		this.#decls.cells.set(name, cell);
		this.#decls.cellSchemas.set(name, schema);
		this.#decls.cellVersions.set(name, version);
		if (options.migrate) this.#decls.cellMigrations.set(name, options.migrate);
		return cell as Cell<Static<S>>;
	}
	get<C extends AnyContract>(type: C, input: InputOf<C>, options?: GetOptions): Ref<C> {
		const host = this.#object.host,
			candidate = this.#previous !== undefined;
		const address = host.addressOf(type, input, options?.principal ?? host.principal, candidate);
		const declared = this.#decls.refs.get(address);
		if (declared) {
			if (declared.contract.fingerprint !== type.fingerprint)
				throw invalid("duplicate", `${this.#object.typeName}: ${type.name} held twice with different contracts`);
			return declared.proxy as Ref<C>;
		}
		const old = this.#previous?.refs.get(address);
		const kept =
			old && old.contract.fingerprint === type.fingerprint && old.status !== "gone" && old.status !== "released";
		const ref = kept ? old : host.acquire(type, input, options, "object", this.#object, candidate);
		this.#decls.refs.set(address, ref);
		if (!kept) this.#created.refs.push(ref);
		return ref.proxy as Ref<C>;
	}
	resource<T>(name: string, declaration: ResourceDeclaration<T>): Resource<T> {
		this.#unique(this.#decls.resources, "resource", name);
		if (!Number.isInteger(declaration.version)) throw new TypeError(`resource ${name}: version must be an integer`);
		const deps = (declaration.deps ?? []).map((dep) => {
			const resolved = refOf(dep) ?? resourceOf(dep);
			if (!resolved) throw new TypeError(`resource ${name}: deps must be references or resources of this object`);
			return resolved;
		});
		const old = this.#previous?.resources.get(name);
		const kept =
			old &&
			old.spec.version === declaration.version &&
			old.exclusive === (declaration.exclusive === true) &&
			old.deps.length === deps.length &&
			old.deps.every((dep, i) => dep === deps[i]);
		const resource = kept ? old : new ResourceImpl(name, declaration as ResourceDeclaration<unknown>, deps);
		if (kept) this.#decls.adopted.set(resource, declaration as ResourceDeclaration<unknown>);
		else this.#created.resources.push(resource);
		this.#decls.resources.set(name, resource);
		return new ResourceFacade(resource, this.#object.host) as Resource<T>;
	}
	on(name: string, source: unknown, ...rest: readonly unknown[]): void {
		this.#unique(this.#decls.listeners, "listener", name);
		const [select, fn] = rest.length === 1 ? [undefined, rest[0]] : rest;
		if (typeof fn !== "function") throw new TypeError(`listener ${name}: the handler must be a function`);
		if (select !== undefined && typeof select !== "function")
			throw new TypeError(`listener ${name}: select must be a function`);
		this.#decls.listeners.set(name, { source, select: select as ListenerDecl["select"], fn: fn as ListenerDecl["fn"] });
	}
	task(fn: Task): void {
		if (typeof fn !== "function") throw new TypeError("a task must be a function");
		this.#decls.tasks.set(`#${this.#decls.tasks.size}`, fn);
	}
	derive<const S extends Sources, T>(sources: S, fn: (...values: SourceValues<S>) => T): Readable<T> {
		if (typeof fn !== "function") throw new TypeError("a derivation needs a function");
		const key = `#${this.#decls.derives.size}`;
		const host = this.#object.host;
		const derived = new Derived<unknown>(key, sources, fn as (...values: never[]) => unknown, {
			dev: host.dev,
			report: (error) => host.report(error),
		});
		this.#decls.derives.set(key, derived);
		this.#created.derives.push(derived);
		return derived as Readable<T>;
	}
	expose<T>(resource: Resource<T>): Exposed<T> {
		const resolved = resourceOf(resource);
		if (!resolved || ![...this.#decls.resources.values()].includes(resolved))
			throw new TypeError("expose takes a resource declared by this object");
		return new ExposedResource(resolved) as unknown as Exposed<T>;
	}
	register<V>(registry: Registry<V>, entries: Readonly<Record<string, V>>): void {
		if (!this.#object.hostLifetime)
			throw invalid("not_host_lifetime", `${this.#object.typeName}: only objects of lifetime "host" may register`);
		for (const [key, value] of Object.entries(entries)) {
			const id = `${registry.name}\0${key}`;
			this.#unique(this.#decls.registrations, "register", id);
			this.#decls.registrations.set(id, { registry, key, value });
		}
	}
}
