import { ChildReloads, reconcileChild, runClusterReload } from "./cluster.ts";
import { type AcceptOptions, Connection, type LinkOptions, type RelayRef } from "./connection.ts";
import {
	type AnyContract,
	bind,
	contractFromDescription,
	type InputOf,
	type LocalContract,
	type LocalDef,
	placedOn,
	placementText,
	type Ref,
	type RemoteContract,
	type RemoteDef,
	resolveHost,
} from "./contract.ts";
import { ChordError, invalid, runAll } from "./errors.ts";
import type { Link } from "./link.ts";
import {
	awaitReady,
	CtxImpl,
	type Decls,
	type Factory,
	type HostCore,
	hostLifetime,
	makeService,
	ObjectImpl,
	type RefCore,
	RefImpl,
	type RefOwner,
	type ServeOptions,
	type ServeOptionsFor,
	type Service,
} from "./object.ts";
import { enqueue } from "./publish.ts";
import type { Registry, RegistryTable, RegistryView } from "./registry.ts";
import { type ReloadOptions, type ReloadReport, runReload } from "./reload.ts";
import { RemoteBinding, RemoteRef } from "./remote.ts";
import { canonicalIdentity, canonicalJson, deepEqual, normalize } from "./schema.ts";
import type { Ctx, GetOptions } from "./types.ts";
import type { Frame } from "./wire.ts";

export interface Serve<P = unknown> {
	<D extends RemoteDef>(
		type: RemoteContract<D>,
		factory: Factory<RemoteContract<D>, P>,
		options?: ServeOptionsFor<RemoteContract<D>>,
	): void;
	<D extends LocalDef>(
		type: LocalContract<D>,
		factory: Factory<LocalContract<D>, P>,
		options?: ServeOptionsFor<LocalContract<D>>,
	): void;
}
export interface RootOptions<P = unknown> {
	readonly principal?: P;
	readonly signal?: AbortSignal;
	readonly codeVersion?: number;
}
export interface FacetApi<P = unknown> {
	readonly serve: Serve<P>;
	readonly name: string;
	readonly signal: AbortSignal;
	root<T>(fn: (ctx: Ctx<P>) => T | Promise<T>, options?: RootOptions<P>): Promise<T>;
	registry<V>(registry: Registry<V>): RegistryView<V>;
}
export interface FacetDefinition<P = unknown> {
	readonly uses?: readonly AnyContract[];
	setup(api: FacetApi<P>): void;
}
export interface Facet<P = unknown> extends FacetDefinition<P> {
	readonly name: string;
}
export function defineFacet<P = unknown>(
	setup: (api: FacetApi<P>) => void,
	options: { readonly uses?: readonly AnyContract[] } = {},
): FacetDefinition<P> {
	return { setup, uses: options.uses };
}
export type FacetLoader = (modules: readonly (string | URL)[]) => Promise<Facet[]>;
export type PluginRef<P = unknown> = Facet<P> | string | URL;
const isFacet = (value: PluginRef): value is Facet => typeof value === "object" && !(value instanceof URL);
export interface HostOptions<P = unknown> {
	readonly name?: string;
	readonly self: NoInfer<P>;
	readonly principalKey?: (principal: P) => string;
	readonly dev?: boolean;
	readonly onError?: (error: unknown) => void;
	readonly taskStopDeadline?: number;
	readonly readyTimeout?: number;
	readonly linger?: { readonly types?: Readonly<Record<string, number>>; readonly cap?: number };
	readonly loader?: FacetLoader;
	readonly kind?: "host" | "client";
	readonly upstream?: { readonly link: Link } & ConnectOptions<P>;
}
export interface ConnectOptions<P = unknown> extends LinkOptions {
	readonly principal: P;
}
export interface Route<P = unknown> {
	authorize(principal: P, hostName: string): boolean | Promise<boolean>;
	resolve(hostName: string): Promise<Link>;
	readonly principal: (hostName: string) => P;
}
export type PrincipalPattern<P> = P extends object
	? { readonly [K in keyof P]?: P[K] }
	: Readonly<Record<string, unknown>>;
export type PrincipalMatch<P = unknown> = ((principal: P) => boolean) | PrincipalPattern<P>;
export interface LoadOptions {
	readonly awaitHostObjects?: boolean;
}
export interface Host<P = unknown> {
	readonly name: string;
	readonly codeVersion: number;
	readonly previousCodeVersion: number | undefined;
	readonly serve: Serve<P>;
	install(facet: Facet<P>, options?: LoadOptions): Promise<void>;
	load(plugins: readonly PluginRef<P>[], options?: LoadOptions): Promise<void>;
	ready(): Promise<void>;
	get<C extends AnyContract>(
		type: C,
		input: InputOf<C>,
		options?: GetOptions<P> & { readonly signal?: AbortSignal },
	): Promise<Ref<C>>;
	hold<C extends AnyContract>(type: C, input: InputOf<C>, options?: GetOptions<P>): Ref<C>;
	root<T>(fn: (ctx: Ctx<P>) => T | Promise<T>, options?: RootOptions<P>): Promise<T>;
	registry<V>(registry: Registry<V>): RegistryView<V>;
	invalidatePrincipal(match: PrincipalMatch<P>): Promise<void>;
	accept(link: Link, options: AcceptOptions<P>): void;
	connect(link: Link, options: ConnectOptions<P>): void;
	route(prefix: string, route: Route<P>): void;
	reload(plugins: readonly PluginRef<P>[], options?: ReloadOptions): Promise<ReloadReport>;
	close(): Promise<void>;
}
export interface CodeVersionState {
	readonly id: number;
	readonly services: Map<string, Service>;
	tables: ReadonlyMap<string, RegistryTable<unknown>>;
	readonly roots: Map<string, number>;
	readonly abort: AbortController;
}
const empty: RegistryTable<never> = new Map<string, never>();
const unknownType = (type: string, host: string): ChordError =>
	new ChordError("unavailable", `${type} is not served by ${host}`, { reason: "unknown_type" });
export function createHost<P = unknown>(options: HostOptions<P>): Host<P> {
	return new HostImpl(options as HostOptions) as unknown as Host<P>;
}

export class HostImpl implements Host, HostCore {
	readonly name: string;
	readonly dev: boolean;
	readonly principal: unknown;
	readonly kind: "host" | "client";
	readonly taskStopDeadline: number;
	readonly readyTimeout: number;
	inFactory = 0;
	failed: unknown;
	readonly objects = new Map<string, ObjectImpl>();
	readonly codeVersions = new Map<number, CodeVersionState>();
	readonly facets = new Map<string, Facet>();
	readonly hostObjects = new Map<string, RefCore>();
	readonly connections = new Set<Connection>();
	upstream: Connection | undefined;
	readonly bindings = new Map<string, RemoteBinding>();
	readonly #lingering = new Map<string, RemoteBinding>();
	readonly #lingerTypes: Readonly<Record<string, number>>;
	readonly #lingerCap: number;
	readonly #routes = new Map<string, Route>();
	readonly #children: ChildReloads;
	remoteModules: Record<string, string[]> = {};
	remoteRemoved: Record<string, string[]> = {};
	current: CodeVersionState;
	previous: CodeVersionState | undefined;
	pending: CodeVersionState | undefined;
	gating: ReadonlySet<string> | undefined;
	reloading = false;
	readonly #key: (principal: unknown) => string;
	readonly #selfKey: string;
	readonly #error: (error: unknown) => void;
	readonly #loader: FacetLoader | undefined;
	readonly #facetRuns = new Map<string, AbortController>();
	readonly #dying = new Map<string, ObjectImpl>();
	readonly #touches = new Map<string, Set<ObjectImpl>>();
	readonly #order = new Map<string, Map<string, number>>();
	readonly #subscribers = new Map<string, Set<(table: RegistryTable<unknown>, version: number) => void>>();
	readonly #foreign = new Map<string, Set<Connection>>();
	readonly #local = new Set<string>();
	readonly #rootLinks = new Map<string, Set<Connection>>();
	readonly #retirement = new Set<() => void>();
	readonly #hellos = new Map<Connection, number>();
	readonly #reloadWaiters: (() => void)[] = [];
	readonly #incarnation = Math.random().toString(36).slice(2, 8);
	#rootId = 0;
	#originId = 0;
	#versionId = 1;
	#retireAllowed = 0;
	constructor(options: HostOptions) {
		this.name = options.name ?? "host";
		this.dev = options.dev ?? false;
		if (!("self" in options)) throw new TypeError("createHost needs `self`: the principal of the host's own code");
		this.principal = options.self;
		this.#key = options.principalKey ?? canonicalJson;
		this.#selfKey = this.#key(options.self);
		this.#error = options.onError ?? ((error) => console.error("axi:", error));
		this.#loader = options.loader;
		this.taskStopDeadline = options.taskStopDeadline ?? 5000;
		this.readyTimeout = options.readyTimeout ?? 60000;
		this.#lingerTypes = options.linger?.types ?? {};
		this.#lingerCap = options.linger?.cap ?? 4;
		this.kind = options.kind ?? "host";
		this.current = { id: 1, services: new Map(), tables: new Map(), roots: new Map(), abort: new AbortController() };
		this.codeVersions.set(1, this.current);
		this.#children = new ChildReloads(this);
		if (options.upstream) this.connect(options.upstream.link, options.upstream);
	}
	get codeVersion(): number {
		return this.current.id;
	}
	get previousCodeVersion(): number | undefined {
		return this.previous?.id;
	}
	currentCodeVersion(): number {
		return this.current.id;
	}
	hasCodeVersion(version: number): boolean {
		return this.codeVersions.has(version);
	}
	pendingCodeVersion(): number | undefined {
		return this.pending?.id;
	}
	*retainedCodeVersions(): Iterable<readonly [number, ReadonlyMap<string, Service>]> {
		for (const [id, version] of this.codeVersions) yield [id, version.services];
		if (this.pending) yield [this.pending.id, this.pending.services];
	}
	service(name: string): Service | undefined {
		return this.current.services.get(name) ?? this.pending?.services.get(name);
	}
	peekNextCodeVersion(): number {
		return this.#versionId + 1;
	}
	nextCodeVersionId(given?: number): number {
		if (given !== undefined && given <= this.current.id)
			throw new Error(`code version ${given} is not newer than ${this.current.id}`);
		return (this.#versionId = given ?? this.#versionId + 1);
	}
	isSelf(principal: unknown): boolean {
		return principal === this.principal || this.#key(principal) === this.#selfKey;
	}
	report(error: unknown): void {
		this.#error(error);
	}
	fail(error: unknown): void {
		this.failed ??= error;
		this.report(error);
	}
	readonly serve = ((type: AnyContract, factory: Factory<AnyContract>, options: ServeOptions = {}) => {
		if (this.reloading) throw new Error("host.serve during a reload; serve from a facet passed to reload()");
		const service = makeService(type, factory, options, "");
		this.serveInto(this.current.services, service);
		if (hostLifetime(service)) this.startHostObject(service);
	}) as Serve;
	serveInto(services: Map<string, Service>, service: Service): void {
		const type = service.contract;
		if (services.has(type.name)) throw new Error(`${type.name} is already served`);
		const placement = type.description.host;
		if (placement && !placedOn(placement, this.name))
			throw new TypeError(`${type.name} is declared for ${placementText(placement)}, but ${this.name} serves it`);
		services.set(type.name, service);
	}
	facetApi(serve: Serve, signal: AbortSignal): FacetApi {
		return {
			serve,
			name: this.name,
			root: (fn, options) => this.root(fn, options),
			registry: (registry) => this.registry(registry),
			signal,
		};
	}
	install(facet: Facet, options: LoadOptions = {}): Promise<void> {
		if (this.reloading) throw new Error("host.install during a reload");
		if (this.facets.has(facet.name)) throw new Error(`facet ${facet.name} is already installed; use reload()`);
		const added: Service[] = [],
			run = new AbortController();
		try {
			facet.setup(
				this.facetApi(
					((type: AnyContract, factory: Factory<AnyContract>, options: ServeOptions = {}) => {
						const service = makeService(type, factory, options, facet.name);
						this.serveInto(this.current.services, service);
						added.push(service);
					}) as Serve,
					run.signal,
				),
			);
		} catch (error) {
			run.abort(error);
			throw error;
		}
		this.facets.set(facet.name, facet);
		this.facetRunChanged(facet.name, run);
		const refs = added.filter(hostLifetime).map((service) => this.startHostObject(service));
		return options.awaitHostObjects === false ? Promise.resolve() : this.#ready(refs);
	}
	async resolve(plugins: readonly PluginRef[]): Promise<Facet[]> {
		const modules = plugins.filter((value): value is string | URL => !isFacet(value));
		if (modules.length && !this.#loader)
			throw new Error("loading modules needs createHost({ loader }), e.g. nodeLoader from @axi/chord/node");
		const loaded = modules.length && this.#loader ? await this.#loader(modules) : [];
		return plugins.map((value) => (isFacet(value) ? value : loaded.shift()!));
	}
	async load(plugins: readonly PluginRef[], options: LoadOptions = {}): Promise<void> {
		await Promise.all((await this.resolve(plugins)).map((facet) => this.install(facet, options)));
	}
	#ready(refs: Iterable<RefCore>): Promise<void> {
		const work = Promise.all([...refs].map((ref) => ref.ready)).then(() => {});
		work.catch(() => {});
		return work;
	}
	ready(): Promise<void> {
		return this.#ready(this.hostObjects.values());
	}
	startHostObject(service: Service): RefCore {
		const ref = this.acquire(service.contract, {}, undefined, "host");
		this.hostObjects.set(service.contract.name, ref);
		ref.ready.catch((error) => this.report(error));
		return ref;
	}
	facetRunChanged(name: string, next: AbortController | undefined): void {
		const old = this.#facetRuns.get(name);
		if (next) this.#facetRuns.set(name, next);
		else this.#facetRuns.delete(name);
		if (old !== next) old?.abort(new ChordError("gone", `facet ${name} was replaced or removed`));
	}
	#principalPart(principal: unknown): string {
		return this.isSelf(principal) ? "host" : `p:${this.#key(principal)}`;
	}
	#bindingService(name: string, candidate: boolean): Service | undefined {
		return (candidate ? this.pending?.services.get(name) : undefined) ?? this.service(name);
	}
	#elsewhere(type: AnyContract, input: unknown): { at: string; input: unknown } | undefined {
		if (type.scope !== "remote" || !type.description.host) return undefined;
		const normalized = normalize(type.input, input, `${type.name} input`),
			at = resolveHost(type.name, type.description.host, normalized);
		return at === this.name ? undefined : { at, input: normalized };
	}
	#remoteKey(type: AnyContract, input: unknown, principal: unknown): string {
		return `@${type.name}\0${canonicalIdentity(type.input, input)}\0${this.#principalPart(principal)}\0${type.fingerprint}`;
	}
	#locate(service: Service, input: unknown, principal: unknown) {
		const type = service.contract,
			normalized = normalize(type.input, input, `${type.name} input`),
			identity = canonicalIdentity(type.input, normalized);
		if (hostLifetime(service)) {
			if (identity !== canonicalIdentity(type.input, normalize(type.input, {}, `${type.name} input`)))
				throw invalid("input", `${type.name} has lifetime "host": its one object has the empty input`);
			principal = this.principal;
		}
		return { address: `${type.name}\0${identity}\0${this.#principalPart(principal)}`, normalized, principal };
	}
	addressOf(type: AnyContract, input: unknown, principal: unknown, candidate = false): string {
		const elsewhere = this.#elsewhere(type, input);
		if (elsewhere) return this.#remoteKey(type, elsewhere.input, principal);
		const service = this.#bindingService(type.name, candidate);
		if (!service) throw unknownType(type.name, this.name);
		return this.#locate(service, input, principal).address;
	}
	acquire(
		type: AnyContract,
		input: unknown,
		options: GetOptions | undefined,
		owner: RefOwner,
		from?: ObjectImpl,
		candidate = false,
	): RefCore {
		const elsewhere = this.#elsewhere(type, input);
		if (elsewhere) return this.#acquireRemote(type, elsewhere.at, elsewhere.input, options, owner);
		const service = this.#bindingService(type.name, candidate);
		if (!service) throw unknownType(type.name, this.name);
		bind(service.contract, service.options.accepts, type);
		const located = this.#locate(service, input, options?.principal ?? this.principal);
		const placement = service.contract.description.host;
		if (placement && resolveHost(type.name, placement, located.normalized) !== this.name)
			throw invalid(
				"placement",
				`${type.name} with this input lives on ${resolveHost(type.name, placement, located.normalized)}, not ${this.name}`,
			);
		let object = this.objects.get(located.address);
		if (from && object && reaches(object, from))
			throw invalid("cycle", `${from.address} -> ${located.address} would create a ref cycle`);
		if (!object) {
			if (this.gating?.has(type.name))
				throw new ChordError("upgrade_conflict", `${type.name} is being upgraded; retry`, { reason: "gate" });
			const dying = this.#dying.get(located.address);
			if (dying?.status === "disposed") this.#dying.delete(located.address);
			object = new ObjectImpl(this, {
				address: located.address,
				typeName: type.name,
				input: located.normalized,
				principal: located.principal,
				hostLifetime: hostLifetime(service),
			});
			this.objects.set(located.address, object);
			object.start(dying?.status === "disposing" ? dying.dispose(false) : undefined);
		}
		const ref = new RefImpl(object, type, owner);
		object.addRef(ref);
		return ref;
	}
	forget(object: ObjectImpl): void {
		if (this.objects.get(object.address) === object) this.objects.delete(object.address);
		if (object.status === "disposing") this.#dying.set(object.address, object);
	}
	disposed(object: ObjectImpl): void {
		if (this.#dying.get(object.address) === object) this.#dying.delete(object.address);
	}
	touch(root: string, object: ObjectImpl): void {
		let touched = this.#touches.get(root);
		if (!touched) {
			touched = new Set();
			this.#touches.set(root, touched);
		}
		touched.add(object);
	}
	async root<T>(fn: (ctx: Ctx) => T | Promise<T>, options: RootOptions = {}): Promise<T> {
		const id = `${this.name}#${this.#incarnation}:${++this.#rootId}`;
		this.#local.add(id);
		return this.joinRoot(id, options.codeVersion ?? this.current.id, fn, options);
	}
	async joinRoot<T>(
		id: string,
		versionId: number,
		fn: (ctx: Ctx) => T | Promise<T>,
		options: { principal?: unknown; signal?: AbortSignal; from?: Connection } = {},
	): Promise<T> {
		const version = this.codeVersions.get(versionId);
		if (!version) {
			this.#local.delete(id);
			throw new ChordError("superseded", `code version ${versionId} is not retained by ${this.name}`);
		}
		if (options.from && !this.#local.has(id)) {
			let links = this.#foreign.get(id);
			if (!links) {
				links = new Set();
				this.#foreign.set(id, links);
			}
			links.add(options.from);
		}
		version.roots.set(id, (version.roots.get(id) ?? 0) + 1);
		const ctx = new CtxImpl(this, {
			signals: options.signal ? [options.signal, version.abort.signal] : [version.abort.signal],
			rootId: id,
			codeVersion: version.id,
			principal: options.principal ?? this.principal,
		});
		try {
			return await fn(ctx);
		} finally {
			ctx.close();
			const remaining = (version.roots.get(id) ?? 1) - 1;
			if (remaining > 0) version.roots.set(id, remaining);
			else {
				version.roots.delete(id);
				if (!this.#foreign.has(id)) this.endRoot(id);
				this.maybeRetire();
				this.#retirementChanged();
			}
		}
	}
	rootSent(id: string, connection: Connection): void {
		let links = this.#rootLinks.get(id);
		if (!links) {
			links = new Set();
			this.#rootLinks.set(id, links);
		}
		links.add(connection);
	}
	endRoot(id: string): void {
		this.#local.delete(id);
		this.#foreign.delete(id);
		for (const object of this.#touches.get(id) ?? []) object.rootEnded(id);
		this.#touches.delete(id);
		for (const connection of this.#rootLinks.get(id) ?? []) connection.send({ t: "root_end", rootId: id });
		this.#rootLinks.delete(id);
	}
	foreignRootEnded(id: string, from: Connection): void {
		const links = this.#foreign.get(id);
		if (!links || !links.delete(from) || links.size) return;
		if ([...this.codeVersions.values()].some((version) => version.roots.has(id))) this.#foreign.delete(id);
		else this.endRoot(id);
	}
	retirable(): boolean {
		return (
			!!this.previous &&
			!this.previous.roots.size &&
			(this.kind === "client" || !this.upstream || this.previous.id <= this.#retireAllowed)
		);
	}
	maybeRetire(): void {
		if (this.retirable()) this.retire();
	}
	allowRetire(id: number): void {
		this.#retireAllowed = Math.max(this.#retireAllowed, id);
		this.maybeRetire();
		this.#retirementChanged();
	}
	watchRetirement(fn: () => void): () => void {
		this.#retirement.add(fn);
		return () => this.#retirement.delete(fn);
	}
	#retirementChanged(): void {
		for (const fn of [...this.#retirement]) fn();
	}
	announceRetired(connection: Connection): void {
		const id = (this.previous ?? this.current).id - 1;
		if (id > 0) connection.send({ t: "retire", codeVersion: id });
	}
	retire(): void {
		const previous = this.previous;
		if (!previous) return;
		this.previous = undefined;
		this.codeVersions.delete(previous.id);
		for (const object of [...this.objects.values()]) this.retireImplementation(object, previous.id);
		for (const connection of this.connections)
			if (connection.role === "downstream" && connection.peer.kind === "host")
				connection.send({ t: "retire", codeVersion: previous.id });
		this.#retirementChanged();
	}
	retireImplementation(object: ObjectImpl, version: number): void {
		const installed = object.implementations.get(version);
		object.implementations.delete(version);
		if (!installed || installed.decls === object.decls) return;
		const kept = object.allDecls();
		const keep = <T>(pick: (decls: Decls) => Iterable<T>): Set<T> =>
			new Set([...kept].flatMap((decls) => [...pick(decls)]));
		const refs = keep((decls) => decls.refs.values()),
			resources = keep((decls) => decls.resources.values()),
			derives = keep((decls) => decls.derives.values());
		for (const derived of installed.decls.derives.values()) if (!derives.has(derived)) derived.detach();
		const closing = [...installed.decls.resources.values()]
			.filter((resource) => !resources.has(resource))
			.sort((a, b) => object.openOrder.indexOf(b) - object.openOrder.indexOf(a));
		object.refreshSchemas();
		void runAll(
			[
				...closing.map((resource) => () => resource.close(object.openOrder)),
				...[...installed.decls.refs.values()].filter((ref) => !refs.has(ref)).map((ref) => () => ref.release()),
			],
			`${object.address}: retiring code version ${version} failed`,
		).catch((error) => this.report(error));
	}
	registry<V>(registry: Registry<V>): RegistryView<V> {
		const table = (ctx?: Ctx): RegistryTable<V> => {
			const version = ctx === undefined ? this.current : this.codeVersions.get(ctx.codeVersion);
			if (!version) throw new ChordError("superseded", `code version ${ctx?.codeVersion} is retired`);
			return (version.tables.get(registry.name) ?? empty) as RegistryTable<V>;
		};
		return {
			table,
			get: (key, ctx) => table(ctx).get(key),
			subscribe: (listener) => {
				let listeners = this.#subscribers.get(registry.name);
				if (!listeners) {
					listeners = new Set();
					this.#subscribers.set(registry.name, listeners);
				}
				const wrapped = listener as (table: RegistryTable<unknown>, version: number) => void;
				listeners.add(wrapped);
				wrapped(table(), this.current.id);
				return () => listeners.delete(wrapped);
			},
		};
	}
	buildTables(entries: Iterable<readonly [ObjectImpl, Decls]>): Map<string, RegistryTable<unknown>> {
		const registries = new Map<string, Map<string, { value: unknown; object: ObjectImpl }>>();
		for (const [object, decls] of entries)
			for (const { registry, key, value } of decls.registrations.values()) {
				let entries = registries.get(registry.name);
				if (!entries) {
					entries = new Map();
					registries.set(registry.name, entries);
				}
				const old = entries.get(key);
				if (old && old.object !== object && registry.conflict === "error")
					throw invalid(
						"registry_conflict",
						`${registry.name}: ${key} registered by ${old.object.address} and ${object.address}`,
					);
				entries.set(key, { value, object });
				let order = this.#order.get(registry.name);
				if (!order) {
					order = new Map();
					this.#order.set(registry.name, order);
				}
				if (!order.has(key)) order.set(key, order.size);
			}
		const tables = new Map<string, RegistryTable<unknown>>();
		for (const [name, entries] of registries) {
			const order = this.#order.get(name)!;
			const sorted = [...entries].sort(([a], [b]) => order.get(a)! - order.get(b)!);
			tables.set(name, new Map(sorted.map(([key, entry]) => [key, entry.value])));
		}
		return tables;
	}
	liveDecls(candidates = false): [ObjectImpl, Decls][] {
		return [...this.objects.values()]
			.filter((object) => object.status === "live" && (candidates || !object.deferredRuntime))
			.map((object) => [object, object.decls]);
	}
	checkRegistrations(object: ObjectImpl, decls: Decls): void {
		if (decls.registrations.size)
			this.buildTables([...this.liveDecls().filter(([other]) => other !== object), [object, decls]]);
	}
	registriesChanged(including?: ObjectImpl): void {
		const entries = this.liveDecls().filter(([object]) => object !== including);
		if (including) entries.push([including, including.decls]);
		this.installTables(this.current, this.buildTables(entries));
	}
	installTables(version: CodeVersionState, tables: Map<string, RegistryTable<unknown>>, all = false): void {
		const before = version.tables;
		version.tables = tables;
		if (version !== this.current) return;
		for (const [name, listeners] of this.#subscribers) {
			const next = tables.get(name) ?? empty;
			if (!all && sameTable(before.get(name) ?? empty, next)) continue;
			const snapshot = [...listeners];
			enqueue(() => {
				for (const fn of snapshot) {
					try {
						fn(next, version.id);
					} catch (error) {
						this.report(error);
					}
				}
			});
		}
	}
	async get<C extends AnyContract>(
		type: C,
		input: InputOf<C>,
		options?: GetOptions & { readonly signal?: AbortSignal },
	): Promise<Ref<C>> {
		const ref = this.acquire(type, input, options, "external");
		await awaitReady(ref, options?.signal ? [options.signal] : [], this.readyTimeout);
		return ref.proxy as Ref<C>;
	}
	hold<C extends AnyContract>(type: C, input: InputOf<C>, options?: GetOptions): Ref<C> {
		return this.acquire(type, input, options, "external").proxy as Ref<C>;
	}
	async invalidatePrincipal(match: PrincipalMatch): Promise<void> {
		const matches =
			typeof match === "function"
				? match
				: (principal: unknown) =>
						principal !== null &&
						typeof principal === "object" &&
						Object.entries(match).every(([key, value]) => deepEqual(Reflect.get(principal, key), value));
		for (const connection of [...this.connections])
			if (connection.role === "downstream" && matches(connection.principal))
				connection.revoke(connection.restamp?.(connection.principal));
		if (typeof match !== "function")
			for (const connection of this.connections)
				if (connection.role === "downstream" && connection.peer.kind === "host")
					connection.send({ t: "invalidate", pattern: match });
		await disposeHoldersFirst(
			[...this.objects.values()].filter((object) => !this.isSelf(object.principal) && matches(object.principal)),
			new ChordError("gone", "principal invalidated"),
			"invalidatePrincipal: disposal failed",
		);
	}
	accept(link: Link, options: AcceptOptions): void {
		const kind = options.kind ?? "client";
		if (kind === "host" && options.name === undefined) throw new TypeError("accepting a host link needs its name");
		this.#connect(link, {
			...options,
			role: "downstream",
			principal: options.principal,
			peer: { kind, name: kind === "host" ? options.name : undefined },
			...(kind === "client" ? { originId: `${this.#incarnation}:${++this.#originId}` } : {}),
		});
	}
	connect(link: Link, options: ConnectOptions): void {
		if (!("principal" in options))
			throw new TypeError("connect needs `principal`: what the parent's own requests act as");
		if (this.upstream?.open) this.upstream.link.close("replaced");
		const connection = this.#connect(link, {
			...options,
			role: "upstream",
			principal: options.principal,
			peer: { kind: "host", name: undefined },
		});
		this.upstream = connection;
		for (const binding of this.bindings.values())
			if (!binding.hold && !binding.ended) connection.hold(binding, binding.applied);
	}
	#connect(link: Link, config: ConstructorParameters<typeof Connection>[2]): Connection {
		const connection = new Connection(this, link, config);
		if (connection.open) this.connections.add(connection);
		return connection;
	}
	route(prefix: string, route: Route): void {
		if (typeof route.principal !== "function")
			throw new TypeError(`route ${prefix} needs \`principal\`: what the routed hosts act as when they call back`);
		this.#routes.set(prefix, route);
	}
	peerHello(connection: Connection, version: number): void {
		if (version > this.current.id) {
			this.report(
				new ChordError("invalid", `${connection.name} runs code version ${version}, ahead of ${this.current.id}`),
			);
			connection.link.close("code version ahead of parent");
			return;
		}
		if (this.reloading) {
			connection.peerCodeVersion = version;
			if (version < this.current.id) connection.fencedCodeVersions.add(version);
			this.#hellos.set(connection, version);
			return;
		}
		if (version === this.current.id) {
			connection.markSynced(version);
			this.announceRetired(connection);
			return;
		}
		connection.peerCodeVersion = version;
		connection.fencedCodeVersions.add(version);
		void reconcileChild(this, connection).catch((error) => {
			this.report(error);
			connection.link.close("reconciliation failed");
		});
	}
	reloadEnded(): void {
		this.reloading = false;
		const hellos = [...this.#hellos];
		this.#hellos.clear();
		for (const [connection, version] of hellos) if (connection.open) this.peerHello(connection, version);
		for (const resolve of this.#reloadWaiters.splice(0)) resolve();
		this.maybeRetire();
	}
	whenReloadEnded(): Promise<void> {
		return this.reloading ? new Promise((resolve) => this.#reloadWaiters.push(resolve)) : Promise.resolve();
	}
	connectionClosed(connection: Connection): void {
		this.connections.delete(connection);
		this.#hellos.delete(connection);
		for (const [id, links] of [...this.#foreign]) if (links.has(connection)) this.foreignRootEnded(id, connection);
		for (const links of this.#rootLinks.values()) links.delete(connection);
		if (this.upstream === connection) {
			this.upstream = undefined;
			this.#children.parentLost();
		}
	}
	bindingIdle(binding: RemoteBinding): void {
		const ms = Object.hasOwn(this.#lingerTypes, binding.contract.name) ? this.#lingerTypes[binding.contract.name] : 0;
		if (ms <= 0 || binding.ended || !binding.applied || this.#lingerCap <= 0) {
			binding.close();
			return;
		}
		binding.lingerTimer = setTimeout(() => binding.close(), ms);
		binding.lingerTimer.unref?.();
		this.#lingering.set(binding.key, binding);
		for (const oldest of this.#lingering.values()) {
			if (this.#lingering.size <= this.#lingerCap) break;
			oldest.close();
		}
	}
	forgetBinding(binding: RemoteBinding): void {
		if (this.bindings.get(binding.key) === binding) this.bindings.delete(binding.key);
		if (this.#lingering.get(binding.key) === binding) this.#lingering.delete(binding.key);
	}
	#childNamed(name: string): Connection | undefined {
		return [...this.connections].find(
			(connection) =>
				connection.open &&
				connection.role === "downstream" &&
				connection.peer.kind === "host" &&
				connection.peer.name === name,
		);
	}
	#acquireRemote(
		type: AnyContract,
		at: string,
		input: unknown,
		options: GetOptions | undefined,
		owner: RefOwner,
	): RefCore {
		const principal =
			options?.principal === undefined || this.isSelf(options.principal) ? undefined : options.principal;
		const key = this.#remoteKey(type, input, principal ?? this.principal);
		let binding = this.bindings.get(key);
		const fresh = !binding || binding.ended;
		if (!binding || binding.ended) {
			binding = new RemoteBinding(this, { key, contract: type, at, input, principal });
			this.bindings.set(key, binding);
		}
		const ref = new RemoteRef(binding, owner, options?.state !== false);
		this.#lingering.delete(key);
		binding.addView(ref);
		if (fresh) this.#hold(binding);
		return ref;
	}
	#hold(binding: RemoteBinding): void {
		const bind = (work: Promise<Connection>): void => {
			void work.then(
				(connection) => {
					if (!binding.ended && !binding.hold) connection.hold(binding, false);
				},
				(error) => binding.gone(error),
			);
		};
		const direct = this.#childNamed(binding.at);
		if (this.upstream) this.upstream.hold(binding, false);
		else if (direct) bind(direct.whenSynced().then(() => direct));
		else {
			const route = this.#routeFor(binding.at);
			if (!route) binding.gone(new ChordError("unavailable", `no route to ${binding.at}`));
			else bind(this.#resolve(route, binding.at, binding.principal ?? this.principal));
		}
	}
	#routeFor(name: string): Route | undefined {
		let best: [string, Route] | undefined;
		for (const entry of this.#routes)
			if (name.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
		return best?.[1];
	}
	async #resolve(
		route: Route,
		name: string,
		principal: unknown,
		still: () => boolean = () => true,
	): Promise<Connection> {
		const refused = (): ChordError => new ChordError("forbidden", `${name} refused for this principal`);
		const revoked = (): ChordError => new ChordError("gone", "principal invalidated while resolving");
		if (!(await route.authorize(principal, name))) throw refused();
		if (!still()) throw revoked();
		const link = await route.resolve(name);
		if (!still()) throw revoked();
		if (!(await route.authorize(principal, name))) throw refused();
		if (!still()) throw revoked();
		const connection =
			[...this.connections].find((connection) => connection.link === link) ??
			this.#connect(link, { role: "downstream", principal: route.principal(name), peer: { kind: "host", name } });
		await connection.whenSynced();
		if (!still()) throw revoked();
		return connection;
	}
	async relay(relay: RelayRef): Promise<void> {
		const frame = relay.frame,
			placement = contractFromDescription(frame.token).description.host;
		if (!placement || resolveHost(frame.token.name, placement, frame.input) !== frame.at)
			throw invalid("placement", `${frame.token.name} with this input does not live on ${frame.at}`);
		const route = this.#routeFor(frame.at);
		if (!route)
			throw this.#childNamed(frame.at)
				? new ChordError("forbidden", `no route authorizes ${frame.at}`)
				: new ChordError("unavailable", `no route to ${frame.at}`);
		const target = await this.#resolve(route, frame.at, relay.principal, () => relay.current);
		if (relay.current) relay.open(target);
	}
	reload(plugins: readonly PluginRef[], options: ReloadOptions = {}): Promise<ReloadReport> {
		if (this.kind !== "client" && this.upstream)
			return Promise.reject(
				new ChordError("unavailable", "reloads are coordinated by the server", { reason: "not_coordinator" }),
			);
		return [...this.connections].some(
			(connection) => connection.role === "downstream" && connection.peer.kind === "host",
		) ||
			options.remote !== undefined ||
			options.remoteRemove !== undefined
			? runClusterReload(this, plugins, options)
			: runReload(this, plugins, options);
	}
	onReloadFrame(connection: Connection, frame: Extract<Frame, { t: "prepare" | "commit" | "abort" }>): void {
		this.#children.handle(connection, frame);
	}
	rememberRemoteModules(
		remote: Readonly<Record<string, readonly string[]>> | undefined,
		remove: Readonly<Record<string, readonly string[]>> | undefined,
	): void {
		for (const prefix of new Set([...Object.keys(remote ?? {}), ...Object.keys(remove ?? {})])) {
			const modules = remote?.[prefix] ?? [],
				removed = remove?.[prefix] ?? [];
			this.remoteModules[prefix] = [...new Set([...(this.remoteModules[prefix] ?? []), ...modules])].filter(
				(module) => !removed.includes(module),
			);
			this.remoteRemoved[prefix] = [...new Set([...(this.remoteRemoved[prefix] ?? []), ...removed])].filter(
				(module) => !modules.includes(module),
			);
		}
	}
	async close(): Promise<void> {
		for (const binding of [...this.#lingering.values()]) binding.close();
		this.hostObjects.clear();
		for (const name of [...this.#facetRuns.keys()]) this.facetRunChanged(name, undefined);
		try {
			await disposeHoldersFirst(
				[...this.objects.values()],
				new ChordError("gone", `host ${this.name} closed`),
				"host close: disposal failed",
			);
		} finally {
			for (const connection of [...this.connections]) connection.link.close("host closed");
		}
	}
}

function sameTable(a: RegistryTable<unknown>, b: RegistryTable<unknown>): boolean {
	if (a.size !== b.size) return false;
	const keys = [...a.keys()];
	return [...b].every(([key, value], index) => keys[index] === key && a.get(key) === value);
}
function reaches(from: ObjectImpl, target: ObjectImpl): boolean {
	const seen = new Set<ObjectImpl>(),
		pending = [from];
	while (pending.length) {
		const object = pending.pop()!;
		if (object === target) return true;
		if (seen.has(object)) continue;
		seen.add(object);
		for (const decls of object.allDecls())
			for (const ref of decls.refs.values()) if (ref.object) pending.push(ref.object);
	}
	return false;
}
async function disposeHoldersFirst(objects: readonly ObjectImpl[], reason: unknown, message: string): Promise<void> {
	const remaining = new Set(objects);
	const collect = (object: ObjectImpl): Set<ObjectImpl> => {
		const targets = new Set<ObjectImpl>();
		for (const decls of object.allDecls())
			for (const ref of decls.refs.values()) if (ref.object !== undefined) targets.add(ref.object);
		return targets;
	};
	const held = new Map(objects.map((object) => [object, collect(object)] as const));
	const errors: unknown[] = [];
	while (remaining.size) {
		const targets = new Set<ObjectImpl>();
		for (const object of remaining) for (const target of held.get(object) ?? []) targets.add(target);
		let wave = [...remaining].filter((object) => !targets.has(object));
		if (!wave.length) wave = [...remaining];
		for (const object of wave) remaining.delete(object);
		for (const result of await Promise.allSettled(wave.map((object) => object.dispose(true, reason))))
			if (result.status === "rejected") errors.push(result.reason);
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length) throw new AggregateError(errors, message);
}
