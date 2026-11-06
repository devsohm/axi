import { NOOP_TELEMETRY_CONTEXT, type SpanAttributes, type TelemetryContext, type TelemetrySpan } from "@axi/telemetry";
import {
	awaitWithContext,
	BACKGROUND_CONTEXT,
	type Context,
	withAbortSignal,
	withoutAbortSignal,
	withTelemetry,
} from "../context/index.ts";
import type { JsonValue } from "../json.ts";
import type { Watchable } from "../watch.ts";
import type { Address, Contract, HostKind, ParamsOf } from "../contracts/index.ts";
import { contractData, type Params } from "../contracts/internal.ts";
import { ObjectsError, type FailureCause, type Principal, type PrincipalKeyFunction } from "../data/index.ts";
import { OpenSpan, capped, countingOnly, ended, parentOf, untraced } from "../telemetry.ts";
import {
	asObjectsError,
	binds,
	canonicalJson,
	checkParams,
	identityKey,
	invalid,
	principalKey,
} from "../data/internal.ts";
import { binaryCodec, type Codec, type Compression, type Link, type PartLimits } from "../link/index.ts";
import { linkLimits } from "../link/internal.ts";
import type { Registry, RegistryValue } from "../registries/index.ts";
import { type RegistryContribution, RegistryRecord, type RegistryValueSource } from "../registries/internal.ts";
import type { HoldRequest } from "../remote/hold.ts";
import { HostLink, type LinkRole } from "../remote/host-link.ts";
import { Path, type Upstream } from "../remote/path.ts";
import type { ProviderSide } from "../remote/provider.ts";
import { RemoteObject } from "../remote/remote-object.ts";
import { Batch, handedOut } from "../state/internal.ts";
import type { ObjectsStore, Store } from "../store/store.ts";
import { Activity, type ActivityCounts } from "./activity.ts";
import { notLive } from "./attempt.ts";
import { Backoff } from "./backoff.ts";
import { type Caller, type Ctx, type GetOptions, withLinkedAbortSignal } from "./ctx.ts";
import { Destination, type Placed } from "./destination.ts";
import type { Facet } from "./facet.ts";
import {
	addStaged,
	emptyStaged,
	recordFactory,
	stagePlugin,
	isPluginName,
	type Staged,
	type PluginFacet,
	type PluginDeclarations,
	type Recorded,
	type Request,
} from "./staging.ts";
import { contributionOf } from "./members.ts";
import type { CloseFailed } from "./native.ts";
import { ObjectsObject, type Holder, type LocalContract, type RemoteContract, type Served } from "./object.ts";
import { type Presence, References } from "./presence.ts";
import { Binding, type CheckedParams, type Held, type LocalTarget, type Reference, type Target } from "./reference.ts";
import type { HostError } from "./report.ts";
import { RevocationKeys, type RevokedBy } from "./revocation.ts";
import { type RootOptions, RootScopes } from "./root.ts";
import { Route, type RouteHandle, type RouteOptions } from "./route.ts";
import { UnboundIndex, type UnboundRequest } from "./unbound.ts";
import { UnboundClock } from "./unbound-clock.ts";
import { uuidv7 } from "./uuid.ts";
import { chainAttempts, OldWork } from "./old-work.ts";
import { ReloadCycles } from "./reload-cycle.ts";
export type { HostError, Position } from "./report.ts";
export type { GetOptions } from "./ctx.ts";
export type PrincipalAttributes<P extends Principal> = (principal: P) => Readonly<SpanAttributes>;
export type HostOptions<P extends Principal = Principal, R extends JsonValue = JsonValue> = {
	readonly address?: Address;
	readonly principal?: P;
	readonly principalKey?: PrincipalKeyFunction<P>;
	readonly telemetry?: TelemetryContext;
	readonly principalAttributes?: PrincipalAttributes<P>;
	readonly onError: (error: HostError) => void;
	readonly closeTimeout?: number;
	readonly reloadDrainTimeout?: number;
	readonly readyTimeout?: number;
	readonly heartbeat?: { readonly ping?: number; readonly close?: number };
	readonly revokedBy?: RevokedBy<P, R>;
	readonly compression?: Compression;
	readonly store?: Store;
};
export type LinkOptions<P extends Principal = Principal> = {
	readonly principal: P;
	readonly trusted?: boolean;
	readonly codec?: Codec;
	readonly limits?: PartLimits;
};
export interface Host<P extends Principal = Principal, R extends JsonValue = JsonValue> {
	readonly address: Address | undefined;
	readonly incarnation: string;
	principalAttributes(principal: P | undefined, context: Context): Readonly<SpanAttributes>;
	load(facets: readonly PluginFacet<P>[], context: Context): Promise<LoadReport>;
	reload(facets: readonly PluginFacet<P>[], context: Context, options?: ReloadOptions): Promise<ReloadReport>;
	get<C extends Contract>(type: C, params: ParamsOf<C>, context: Context, options?: GetOptions): Promise<Reference<C>>;
	hold<C extends Contract>(type: C, params: ParamsOf<C>, context: Context, options?: GetOptions): Held<C>;
	accept(link: Link, options: LinkOptions<P>, context: Context): void;
	connect(link: Link, options: LinkOptions<P>, context: Context): void;
	route<N extends string, Q extends Params>(
		kind: HostKind<N, Q>,
		options: RouteOptions<P, HostKind<N, Q>>,
		context: Context,
	): RouteHandle<HostKind<N, Q>>;
	revoke(revocation: R, context: Context): void;
	references<C extends Contract>(type: C): Watchable<readonly Presence<C, P>[]>;
	readonly activity: Watchable<ActivityCounts>;
	registry<C, V>(registry: Registry<C, V>, context: Context, options?: GetOptions): Promise<RegistryValue<V>>;
	root<T>(fn: (context: Ctx<P>) => Promise<T>, context: Context, options?: RootOptions<P>): Promise<T>;
	close(context: Context): Promise<void>;
}
export type AnyHost = Omit<ObjectsHost, "load" | "reload" | "accept" | "connect" | "route" | "references" | "root">;
export type Serving =
	| { readonly kind: "object"; readonly object: ObjectsObject }
	| { readonly kind: "waiting"; readonly cause: FailureCause };
export function createHost<P extends Principal = Principal, R extends JsonValue = JsonValue>(
	options: HostOptions<P, R>,
): Host<P, R> {
	return new ObjectsHost<P, R>(options);
}
export type ReloadedObject = { readonly object: string } & (
	| { readonly kind: "restarted" | "ended" | "retried" }
	| { readonly kind: "parked"; readonly cause: FailureCause }
);
export type ReloadReport = {
	readonly plugins: {
		readonly added: readonly string[];
		readonly changed: readonly string[];
		readonly removed: readonly string[];
	};
	readonly failed: readonly PluginFailure[];
	readonly objects: readonly ReloadedObject[];
};
export type PluginFailure = { readonly plugin: string; readonly error: unknown };
export type LoadReport = { readonly failed: readonly PluginFailure[] };
export type ReloadOptions = { readonly failed?: readonly PluginFailure[] };
export type CommittedReload = ReloadReport["plugins"] & { readonly failed: readonly string[] };
type Loaded<P extends Principal> = {
	readonly facet: Facet<P>;
	readonly declarations: PluginDeclarations<P>;
	readonly contributions: readonly RegistryContribution[];
};
type Action = { readonly object: ObjectsObject } & (
	| { readonly kind: "end" }
	| { readonly kind: "restart" | "retry"; readonly served: Served; readonly requests: readonly Request[] }
);
type ReloadPlan<P extends Principal> = {
	readonly staged: Staged<P>;
	readonly changed: readonly string[];
	readonly added: readonly string[];
	readonly removed: readonly string[];
	readonly failed: readonly PluginFailure[];
	readonly actions: readonly Action[];
};
export class ObjectsHost<P extends Principal = Principal, R extends JsonValue = JsonValue> implements Host<P, R> {
	readonly batch: Batch;
	readonly timeouts: { readonly close: number; readonly ready: number; readonly reload: number };
	readonly oldWork = new OldWork();
	readonly reloadCycles = new ReloadCycles();
	readonly backoff = new Backoff((identity) => {
		const object = this.#objects.get(identity);
		if (object) object.attempt();
		else this.backoff.delete(identity);
	});
	readonly address: Address | undefined;
	readonly spanHost: string;
	readonly telemetry: TelemetryContext;
	readonly principal: P | undefined;
	readonly incarnation = uuidv7();
	readonly compression: Compression | undefined;
	readonly store: ObjectsStore | undefined;
	readonly unplaced = new Path(() => {});
	readonly relays = new Map<number, ProviderSide>();
	readonly #activity: Activity;
	readonly #key: PrincipalKeyFunction<P> | undefined;
	readonly #principalAttributes: HostOptions<P>["principalAttributes"];
	readonly #counting: TelemetrySpan | undefined;
	readonly #revocations: RevocationKeys;
	readonly #onError: (error: HostError) => void;
	readonly #presence = new Map<string, References>();
	readonly #served = new Map<string, Served>();
	readonly #objects = new Map<string, ObjectsObject>();
	readonly #ending = new Map<string, Promise<void>>();
	readonly #unboundClock = new UnboundClock((error) => this.report(error));
	readonly #requests = new UnboundIndex(this.#unboundClock);
	readonly #publication = Promise.withResolvers<void>();
	readonly #links = new Set<HostLink>();
	readonly #parent = new Path(() => {});
	readonly #routes = new Map<string, Route>();
	readonly #destinations: Destination;
	readonly #closingSignal = new AbortController();
	readonly #heartbeat: { readonly ping: number; readonly close: number };
	readonly #registries = new Map<string, RegistryRecord>();
	readonly #roots = new RootScopes(this);
	readonly #plugins = new Map<string, Loaded<P>>();
	#reloadTail: Promise<void> = Promise.resolve();
	#origin = 1;
	#published = false;
	#status: "new" | "loading" | "loaded" | "closed" = "new";
	#timer: ReturnType<typeof setInterval> | undefined;
	#shutdown: Promise<void> | undefined;
	constructor(options: HostOptions<P, R>) {
		this.address = options.address;
		this.spanHost = (options.address?.key ?? "client").slice(0, 256);
		this.telemetry = options.telemetry ?? NOOP_TELEMETRY_CONTEXT;
		this.principal = options.principal;
		this.#key = options.principalKey;
		this.#principalAttributes = options.principalAttributes;
		this.#counting = options.telemetry?.metrics && !untraced(options.telemetry) ? countingOnly(options.telemetry.metrics) : undefined;
		this.#onError = options.onError;
		this.batch = new Batch((error) => this.report(error), options.telemetry?.metrics);
		this.#activity = new Activity(this.batch);
		this.compression = options.compression;
		this.#revocations = new RevocationKeys(options.revokedBy as RevokedBy<Principal, JsonValue> | undefined);
		const close = options.closeTimeout ?? 30000;
		this.timeouts = { close, ready: options.readyTimeout ?? 60000, reload: Math.min(close, options.reloadDrainTimeout ?? 5000) };
		this.#heartbeat = { ping: options.heartbeat?.ping ?? 15000, close: options.heartbeat?.close ?? 30000 };
		this.#destinations = new Destination(this.address, this.#routes, this.#parent);
		this.store = options.store as ObjectsStore | undefined;
		this.store?.attach({
			batch: this.batch,
			failed: (error) => {
				this.report({ kind: "storage_failed", error });
				this.#shutdown ??= this.#close();
				void this.#shutdown.catch(() => {});
			},
		});
	}
	async load(facets: readonly PluginFacet<P>[], context: Context): Promise<LoadReport> {
		this.batch.assertOutside("load");
		this.#assertOpen();
		if (this.#status !== "new") throw new Error("load runs once per host");
		for (const { name } of facets) if (!isPluginName(name)) throw new Error(`"${name}" is not a valid plugin name`);
		this.#status = "loading";
		if (untraced(context.telemetry)) return this.#load(facets, context);
		return context.telemetry.startSpan({ name: "objects.load", attributes: { "objects.host": this.spanHost, plugins: facets.length } }, async (span) => {
			try {
				const result = await this.#load(facets, withTelemetry(span, context));
				span.setAttributes({ failed: result.failed.length });
				return result;
			} catch (error) { ended(span, "load_failed", error, context.abortSignal); throw error; }
		});
	}
	async #load(facets: readonly PluginFacet<P>[], context: Context): Promise<LoadReport> {
		const staged = emptyStaged<P>(),
			failed: PluginFailure[] = [],
			given = new Set<string>();
		for (const plugin of facets) {
			const error = given.has(plugin.name)
				? new Error(`plugin "${plugin.name}" is loaded twice`)
				: this.#stage(staged, plugin);
			given.add(plugin.name);
			if (error !== undefined) failed.push({ plugin: plugin.name, error });
		}
		this.batch.commit(() => {
			for (const [name, served] of staged.types) this.#served.set(name, served);
			this.#install(staged, staged.plugins.keys());
			for (const record of this.#registries.values()) record.composeServed();
		}, context);
		this.#published = true;
		this.#publication.resolve();
		for (const record of this.#registries.values()) record.reportUndeclared();
		this.#requests.wakeAll();
		const starting: Promise<void>[] = [];
		for (const served of this.#served.values())
			if (served.kind === "local" && served.hostLifetime)
				starting.push(this.#object(served, { params: {}, key: "" }, undefined, context).firstOutcome);
		await Promise.all(starting);
		if (this.#status === "loading") this.#status = "loaded";
		return { failed };
	}
	async get<C extends Contract>(
		type: C,
		params: ParamsOf<C>,
		context: Context,
		options: GetOptions = {},
	): Promise<Reference<C>> {
		return (await this.acquire(type, params, this.#caller(), context, options)).reference as Reference<C>;
	}
	hold<C extends Contract>(type: C, params: ParamsOf<C>, context: Context, options: GetOptions = {}): Held<C> {
		this.batch.assertOutside("hold");
		this.#assertLoadCalled(type.name);
		return this.#hold(type, params, this.#caller(), context, options).reference as Held<C>;
	}
	accept(link: Link, options: LinkOptions<P>, context: Context): void {
		this.#assertOpen();
		this.#link(link, "child", options, context);
	}
	connect(link: Link, options: LinkOptions<P>, context: Context): void {
		this.#assertOpen();
		if (this.#parent.link) throw new Error("connect: this host has an open parent link");
		const connection = this.#link(link, "parent", options, context);
		if (connection.open) this.#parent.connected(connection);
	}
	route<N extends string, Q extends Params>(
		kind: HostKind<N, Q>,
		options: RouteOptions<P, HostKind<N, Q>>,
		context: Context,
	): RouteHandle<HostKind<N, Q>> {
		this.#assertOpen();
		if (this.#status !== "new") throw new Error("route: routes are declared before load");
		if (this.#routes.has(kind.kind)) throw new Error(`route: ${kind.kind} is routed already`);
		const route = new Route(
			kind as unknown as HostKind,
			options as unknown as RouteOptions<Principal, HostKind>,
			this,
			withAbortSignal(this.#closingSignal.signal, context),
		);
		this.#routes.set(kind.kind, route);
		return { retry: (address) => route.retry(address.key), suspend: (address) => route.suspend(address.key) };
	}
	revoke(revocation: R, context: Context): void {
		let count = 0;
		const key = canonicalJson(revocation, context);
		const revoked = (principal: Principal): boolean => {
			if (
				this.principal !== undefined &&
				principalKey(this.principal, context, this.#key) === principalKey(principal as P, context, this.#key)
			)
				return false;
			return this.#revocations.revokes(principal, key, context);
		};
		const error = (label: string): ObjectsError =>
			new ObjectsError({ code: "forbidden", reason: "revoked", message: `${label}: revoked` });
		for (const object of [...this.#objects.values()])
			if (object.principal !== undefined && revoked(object.principal)) { object.end(error(object.label)); count++; }
		const waiting = error("an unbound request");
		this.#requests.revoke(revoked, waiting);
		for (const link of this.#links) link.revokeUnbound(revoked, waiting);
		for (const holder of this.#holders())
			if (holder.kind === "remote" && holder.caller.principal !== undefined && revoked(holder.caller.principal))
				holder.revoke(error(holder.label));
		for (const link of this.#links) if (link.role === "route") link.send({ kind: "revoke", revocation });
		for (const link of [...this.#links]) if (link.role === "child" && revoked(link.principal)) { link.close(); count++; }
		if (!untraced(context.telemetry)) {
			const span = new OpenSpan(context.telemetry, "objects.revoke", { "objects.host": this.spanHost });
			span.span.setAttributes({ count });
			span.end();
		}
	}
	get activity(): Watchable<ActivityCounts> {
		return this.#activity as unknown as Watchable<ActivityCounts>;
	}
	references<C extends Contract>(type: C): Watchable<readonly Presence<C, P>[]> {
		let presence = this.#presence.get(type.name);
		if (!presence) {
			presence = new References(this.batch);
			for (const object of this.#objects.values())
				if (object.served.contract.name === type.name)
					for (const holder of object.holders) if (holder.listed) presence.record(object, holder);
			this.#presence.set(type.name, presence);
		}
		return presence as unknown as Watchable<readonly Presence<C, P>[]>;
	}
	async registry<C, V>(
		registry: Registry<C, V>,
		context: Context,
		options: GetOptions = {},
	): Promise<RegistryValue<V>> {
		this.batch.assertOutside("registry");
		this.#assertOpen();
		this.#assertLoadCalled(`registry ${registry.name}`);
		const timeout = options.readyTimeout ?? this.timeouts.ready,
			expired = new AbortController(),
			linked = withLinkedAbortSignal(expired.signal, context);
		let last: unknown;
		const timer = setTimeout(() => expired.abort(last ?? notLive(`registry ${registry.name}`, timeout)), timeout);
		const close = (): void => expired.abort(this.#closedError());
		this.#closingSignal.signal.addEventListener("abort", close, { once: true });
		try {
			await awaitWithContext(this.#publication.promise, linked.context);
			this.#assertOpen();
			const value = this.registryRecord(registry.name).value(registry.version);
			const usable = (): boolean => {
				const current = value.start();
				if (current.kind === "value" || current.last !== undefined) return true;
				last = current.error;
				return false;
			};
			if (!usable()) await waitForRegistry(value, usable, linked.context);
			return value as RegistryValue<V>;
		} finally {
			clearTimeout(timer);
			this.#closingSignal.signal.removeEventListener("abort", close);
			linked.release();
		}
	}
	async root<T>(fn: (context: Ctx<P>) => Promise<T>, context: Context, options: RootOptions<P> = {}): Promise<T> {
		this.batch.assertOutside("root");
		this.#assertOpen();
		const principal = "principal" in options ? options.principal : this.principal;
		const run = fn as (ctx: Ctx) => Promise<T>;
		if (!options.trace || untraced(this.telemetry)) return this.#roots.run(run, principal, this.#counted(context));
		return this.telemetry.startSpan({ name: options.trace.name, attributes: { "objects.host": this.spanHost, ...options.trace.attributes } }, async (span) => {
			try { return await this.#roots.run(run, principal, withTelemetry(span, context)); }
			catch (error) { ended(span, "trace_failed", error, context.abortSignal); throw error; }
		});
	}
	principalAttributes(principal: P | undefined, context: Context): Readonly<SpanAttributes> {
		if (principal === undefined) return {};
		return this.#principalAttributes ? this.#principalAttributes(principal) : { "objects.principal": principalKey(principal, context, this.#key).slice(0, 256) };
	}
	#counted(context: Context): Context {
		return this.#counting && context.telemetry === NOOP_TELEMETRY_CONTEXT ? withTelemetry(this.#counting, context) : context;
	}
	registryRecord(name: string): RegistryRecord {
		let record = this.#registries.get(name);
		if (!record) {
			record = new RegistryRecord(name, this.batch, (error) => this.report(error), this.#unboundClock);
			this.#registries.set(name, record);
		}
		return record;
	}
	async close(_context: Context): Promise<void> {
		this.batch.assertOutside("close");
		this.#shutdown ??= this.#close();
		return this.#shutdown;
	}
	get published(): boolean {
		return this.#published;
	}
	get closing(): boolean {
		return this.#status === "closed";
	}
	undeclaredRegistries(): { readonly name: string; readonly version: number }[] {
		return [...this.#registries].flatMap(([name, record]) => record.providedVersion === undefined && record.newestContribution !== undefined ? [{ name, version: record.newestContribution }] : []).sort((a, b) => a.name < b.name ? -1 : 1);
	}
	unservedNames(): readonly string[] {
		return this.#requests.names().filter((name) => !this.#served.has(name) && this.#registries.get(name)?.providedVersion === undefined);
	}
	activationsUnderWay(): number { return [...this.#objects.values()].filter((object) => object.activating).length; }
	index(name: string, request: UnboundRequest, cause?: FailureCause): void {
		this.#requests.add(name, request, cause);
	}
	unindex(name: string, request: UnboundRequest): void {
		this.#requests.delete(name, request);
	}
	async acquire(
		type: Contract,
		params: unknown,
		caller: Caller,
		context: Context,
		options: GetOptions,
	): Promise<Binding> {
		this.batch.assertOutside("get");
		this.#assertLoadCalled(type.name);
		const binding = this.#hold(type, params, caller, context, options);
		const timeout = options.readyTimeout ?? this.timeouts.ready,
			expired = new AbortController(),
			linked = withLinkedAbortSignal(expired.signal, context);
		const timer = setTimeout(() => expired.abort(binding.lastFailure ?? notLive(binding.label, timeout)), timeout);
		try {
			const live = binding.live(linked.context), target = binding.target;
			await (target instanceof ObjectsObject ? this.waitAsOldWork(live, target, type, context) : live);
			return binding;
		} catch (error) {
			binding.release();
			throw error;
		} finally {
			clearTimeout(timer);
			linked.release();
		}
	}
	waitAsOldWork<T>(waiting: Promise<T>, target: ObjectsObject, contract: Contract, context: Context): Promise<T> {
		if (!this.oldWork.of(context)) return waiting;
		const chain = chainAttempts(context);
		return chain.size ? this.reloadCycles.wait(waiting, target, contract, chain) : waiting;
	}
	count(kind: keyof ActivityCounts, delta: number): void {
		this.#activity.count(kind, delta);
	}
	referenced(object: ObjectsObject, holder: Holder, context: Context): void {
		if (holder.listed) this.#presence.get(object.served.contract.name)?.add(object, holder, context);
	}
	unreferenced(object: ObjectsObject, holders: Iterable<Holder>, context: Context): void {
		this.#presence.get(object.served.contract.name)?.remove(holders, context);
	}
	report(error: HostError): void {
		try {
			if ("error" in error) handedOut(error.error);
			else if ("failure" in error) handedOut(error.failure.error);
			this.#onError(error);
		} catch {}
	}
	reference(type: Contract, dependent: LocalTarget | undefined, caller: Caller, options: GetOptions): Binding {
		this.#assertOpen();
		return new Binding(type, this.batch, dependent, caller, options.readyTimeout ?? this.timeouts.ready);
	}
	bind(binding: Binding, type: Contract, checked: CheckedParams, context: Context): Target | undefined {
		binding.whenUnbound((cause) =>
			this.#wait(binding, type.name, cause, () => this.#place(binding, type, checked, context)),
		);
		const principal = binding.caller.principal,
			placed = this.#destinations.reference(type, checked.params, principal, context);
		if (placed.kind === "path") {
			const object = new RemoteObject(
				this,
				type,
				checked,
				placed.address,
				binding.caller,
				placed.path,
				binding.dependent instanceof ObjectsObject ? binding.dependent : undefined,
				context,
			);
			placed.path.attach(object);
			binding.bind(object);
			return object;
		}
		const served = this.#served.get(type.name),
			mismatch =
				missing(served, type.kind, type.name, type.version, type.fingerprint) ??
				this.#misplaced(type, served!, checked.params);
		if (mismatch) {
			if (mismatch.error.code === "contract_mismatch" && this.oldWork.of(context)) {
				const old = this.#objects.get(this.#identity(served!, checked, principal, context));
				if (!old?.oldServes(type.version, type.fingerprint)) throw mismatch.error;
				binding.bind(old);
				return old;
			}
			this.#wait(binding, type.name, mismatch, () => this.#place(binding, type, checked, context));
			return;
		}
		if (served!.kind !== "local" && principal === undefined)
			throw new ObjectsError({ code: "forbidden", message: `${type.name}: an anonymous caller gets no remote object` });
		const object = this.#object(served!, checked, principal, context, [], binding.dependent);
		binding.bind(object);
		if (object.activationSpan && !untraced(context.telemetry)) context.telemetry.addLink({ context: object.activationSpan });
		return object;
	}
	place(request: HoldRequest, link: HostLink, caller: Caller, context: Context): Placed {
		this.#assertOpen();
		return this.#destinations.hold(request, link, caller.principal, context);
	}
	serving(request: HoldRequest, params: unknown, principal: Principal, context: Context): Serving {
		const served = this.#served.get(request.type),
			cause = missing(served, "remote", request.type, request.version, request.fingerprint);
		if (cause) return { kind: "waiting", cause };
		const checked = checkParams(served!.contract, params, context),
			error = this.#destinations.misplaced(served!.contract, checked.params);
		if (error) return { kind: "waiting", cause: { kind: "waiting", error } };
		const chain = request.chain ?? [],
			object = this.#object(served!, checked, principal, context, chain, undefined, parentOf(request.trace, this.telemetry)),
			id = object.activationId;
		if (id !== undefined && chain.includes(id)) throw this.cycle(chain, id, [object.label]);
		return { kind: "object", object };
	}
	pathOf(type: Contract, params: ParamsOf<Contract>, principal: Principal | undefined): Path {
		const placed = this.#destinations.reference(type, params, principal, BACKGROUND_CONTEXT);
		if (placed.kind === "path") return placed.path;
		throw new ObjectsError({ code: "unavailable", message: `${type.name} is placed here now` });
	}
	cycle(chain: readonly string[], id: string, closing: readonly string[]): ObjectsError {
		const labels = new Map([...this.#objects.values()].map((object) => [object.activationId, object.label]));
		return invalid(
			"cycle",
			`dependency cycle: ${[...chain.slice(chain.indexOf(id)).map((entry) => labels.get(entry) ?? "…"), ...closing].join(" → ")}`,
		);
	}
	relayOrigin(side: ProviderSide): number {
		const id = this.#origin++;
		this.relays.set(id, side);
		return id;
	}
	routeLink(link: Link, options: LinkOptions<Principal>, context: Context): HostLink {
		return this.#link(link, "route", options, context);
	}
	linkOpened(link: HostLink): void {
		if (link.role === "route") for (const route of this.#routes.values()) route.opened(link);
	}
	unlink(link: HostLink): void {
		this.#links.delete(link);
		for (const relay of this.relays.values()) relay.unlinked(link);
		if (!this.#links.size) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		if (link.role === "parent") this.#parent.disconnected(link);
		else if (link.role === "route") for (const route of this.#routes.values()) if (route.closed(link)) break;
	}
	wentLive(object: ObjectsObject): void {
		this.#objects.delete(object.identity);
		this.#objects.set(object.identity, object);
		this.backoff.delete(object.identity);
	}
	forget(object: ObjectsObject): void {
		this.#objects.delete(object.identity);
		this.backoff.ended(object.identity);
	}
	ending(identity: string, closing: Promise<void>): void {
		const previous = this.#ending.get(identity),
			joined = previous ? Promise.all([previous, closing]).then(() => {}) : closing;
		this.#ending.set(identity, joined);
		void joined.then(() => {
			if (this.#ending.get(identity) === joined) this.#ending.delete(identity);
		});
	}
	endingOf(identity: string): Promise<void> | undefined {
		return this.#ending.get(identity);
	}
	#hold(type: Contract, params: unknown, caller: Caller, context: Context, options: GetOptions): Binding {
		this.#assertOpen();
		const checked = checkParams(type, params, context),
			binding = this.reference(type, undefined, caller, options),
			place = (): void => this.#place(binding, type, checked, context);
		if (this.#published) place();
		else this.#wait(binding, type.name, undefined, place);
		return binding;
	}
	#place(binding: Binding, type: Contract, checked: CheckedParams, context: Context): void {
		if (this.closing) {
			binding.end(this.#closedError());
			return;
		}
		try {
			this.bind(binding, type, checked, context);
		} catch (error) {
			binding.refuse({ kind: "broken", error: asObjectsError(error, type.name) }, () =>
				this.#place(binding, type, checked, context),
			);
		}
	}
	#wait(binding: Binding, name: string, cause: FailureCause | undefined, place: () => void): void {
		binding.wait(cause, place, () => this.#requests.delete(name, binding));
		this.#requests.add(name, binding, cause);
	}
	#misplaced(type: Contract, served: Served, params: ParamsOf<Contract>): FailureCause | undefined {
		if (served.kind !== "remote" || contractData(type).hostAddress === contractData(served.contract).hostAddress)
			return;
		const error = this.#destinations.misplaced(served.contract, params);
		return error ? { kind: "waiting", error } : undefined;
	}
	#caller(): Caller {
		return { principal: this.principal, incarnation: this.incarnation };
	}
	#link(transport: Link, role: LinkRole, options: LinkOptions<Principal>, context: Context): HostLink {
		const trusted = options.trusted ?? false;
		const link = new HostLink(
			this,
			transport,
			{
				role,
				principal: options.principal,
				trusted,
				codec: options.codec ?? binaryCodec,
				limits: linkLimits(trusted, options.limits),
			},
			this.#counted(withoutAbortSignal(context)),
		);
		if (link.open) {
			this.#links.add(link);
			if (this.#timer === undefined) {
				const every = Math.min(this.#heartbeat.ping, this.#heartbeat.close) / 10;
				let last = Date.now();
				this.#timer = setInterval(() => {
					const now = Date.now();
					const late = now - last - every;
					last = now;
					for (const current of [...this.#links]) current.tick(now, late >= every ? late : 0, this.#heartbeat.ping, this.#heartbeat.close);
				}, every);
			}
		}
		return link;
	}
	#object(
		served: Served,
		checked: CheckedParams,
		principal: Principal | undefined,
		context: Context,
		chain: readonly string[] = [],
		dependent?: LocalTarget,
		trigger: TelemetryContext = context.telemetry,
	): ObjectsObject {
		const identity = this.#identity(served, checked, principal, context);
		let object = this.#objects.get(identity);
		if (!object) {
			const ancestry = dependent instanceof ObjectsObject ? (dependent.activationChain() ?? chain) : chain;
			object = new ObjectsObject(
				this,
				served,
				checked.params,
				served.kind === "local" ? undefined : principal,
				checked.key,
				identity,
				withoutAbortSignal(context),
				ancestry,
				trigger,
			);
			this.#objects.set(identity, object);
			if (!this.backoff.waiting(identity)) object.attempt();
		}
		return object;
	}
	#identity(served: Served, checked: CheckedParams, principal: Principal | undefined, context: Context): string {
		return served.kind === "local"
			? identityKey(served.contract as LocalContract, checked.key)
			: identityKey(served.contract as RemoteContract, checked.key, principalKey(principal as P, context, this.#key));
	}
	async #close(): Promise<void> {
		this.#status = "closed";
		const error = this.#closedError();
		this.#closingSignal.abort(error);
		const links = [...this.#links];
		for (const role of ["child", "route", "parent"]) for (const link of links) if (link.role === role) link.close();
		this.#roots.close(error);
		for (const holder of this.#holders()) if (holder.kind === "remote") holder.lost(error);
		this.#requests.close(error);
		this.#publication.resolve();
		this.backoff.clear();
		const teardowns = [...this.#objects.values()].reverse().map((object) => object.stop());
		await Promise.all(this.#ending.values());
		const failures: CloseFailed[] = [];
		for (const teardown of teardowns) failures.push(...(await teardown()));
		this.#served.clear();
		this.#plugins.clear();
		for (const record of this.#registries.values()) record.close();
		this.#registries.clear();
		this.store?.detach();
		if (failures.length)
			throw new AggregateError(
				failures.map((failure) => failure.error),
				`host.close: ${failures.length} native close(s) threw`,
			);
	}
	#holders(): Upstream[] {
		return [
			...this.#parent.holders(),
			...this.unplaced.holders(),
			...Array.from(this.#routes.values(), (route) => route.holders()).flat(),
		];
	}
	#stage(staged: Staged<P>, plugin: PluginFacet<P>): unknown {
		try {
			return addStaged(staged, stagePlugin(plugin, this));
		} catch (error) {
			return error;
		}
	}
	#reloadPlan(facets: readonly PluginFacet<P>[], before: readonly PluginFailure[], context: Context): ReloadPlan<P> {
		const given = new Map<string, PluginFacet<P>>(),
			duplicates: PluginFailure[] = [];
		for (const plugin of facets) {
			if (given.has(plugin.name))
				duplicates.push({ plugin: plugin.name, error: new Error(`plugin "${plugin.name}" is loaded twice`) });
			else given.set(plugin.name, plugin);
		}
		const failed = new Map(before.map(({ plugin, error }) => [plugin, error]));
		const removed = [...this.#plugins.keys()].filter((name) => !given.has(name));
		for (;;) {
			const staged = emptyStaged<P>(),
				fresh: PluginFacet<P>[] = [];
			for (const [name, plugin] of given) {
				const loaded = this.#plugins.get(name);
				if (loaded && (loaded.facet === plugin.facet || failed.has(name))) addStaged(staged, loaded.declarations);
				else if (!failed.has(name)) fresh.push(plugin);
			}
			const failures = new Map<string, unknown>();
			for (const plugin of fresh) {
				const error = this.#stage(staged, plugin);
				if (error !== undefined) failures.set(plugin.name, error);
			}
			const updated = new Set(fresh.map(({ name }) => name)),
				replaced = new Set([...updated, ...removed]);
			const actions: Action[] = [],
				recorded: { readonly plugin: string; readonly declarations: Recorded }[] = [];
			if (failures.size === 0) {
				for (const object of this.#objects.values()) {
					if (!replaced.has(object.served.plugin)) continue;
					const served = staged.types.get(object.served.contract.name);
					if (served === undefined || served.kind !== object.served.kind) {
						actions.push({ object, kind: "end" });
						continue;
					}
					try {
						const declarations = recordFactory(object, served, context);
						recorded.push({ plugin: served.plugin, declarations });
						actions.push({ object, served, kind: object.reloadFate(), requests: declarations.requests });
					} catch (error) {
						if (!failures.has(served.plugin)) failures.set(served.plugin, error);
					}
				}
			}
			if (failures.size === 0 && failed.size > 0) {
				for (const { plugin, declarations } of recorded) {
					if (!updated.has(plugin) || failures.has(plugin)) continue;
					for (const request of declarations.requests) {
						const reason = this.#failedDependency(staged, request, failed);
						if (reason === undefined) continue;
						failures.set(plugin, new Error(`plugin "${plugin}": ${reason}`));
						break;
					}
				}
			}
			if (failures.size > 0) {
				for (const [name, error] of failures) failed.set(name, error);
				continue;
			}
			return {
				staged,
				removed,
				actions,
				added: fresh.filter(({ name }) => !this.#plugins.has(name)).map(({ name }) => name),
				changed: fresh.filter(({ name }) => this.#plugins.has(name)).map(({ name }) => name),
				failed: [...duplicates, ...[...failed].map(([plugin, error]) => ({ plugin, error }))],
			};
		}
	}
	#failedDependency(staged: Staged<P>, request: Request, failed: ReadonlyMap<string, unknown>): string | undefined {
		const name = request.kind === "type" ? request.contract.name : request.registry.name;
		const owner = request.kind === "type" ? staged.types.get(name)?.plugin : staged.registries.get(name)?.plugin;
		if (owner !== undefined && !failed.has(owner)) return;
		let version: number, label: string;
		if (request.kind === "type") {
			const { contract, params } = request,
				served = staged.types.get(name);
			try {
				if (!this.#destinations.placedHere(contract, params)) return;
			} catch {
				return;
			}
			if (served && !missing(served, contract.kind, name, contract.version, contract.fingerprint)) {
				try {
					if (!this.#misplaced(contract, served, params)) return;
				} catch {}
			}
			version = contract.version;
			label = name;
		} else {
			version = request.registry.version;
			label = `registry ${name}`;
			const served = staged.registries.get(name);
			if (
				served &&
				(served.token.version === version ||
					(served.token.version > version && served.provider.accepts?.[version]?.value !== undefined))
			)
				return;
		}
		return owner === undefined
			? `needs ${label} v${version}, which no plugin serves now (a plugin failed)`
			: `needs ${label} v${version}, which plugin "${owner}" serves on its old code`;
	}
	reload(facets: readonly PluginFacet<P>[], context: Context, options: ReloadOptions = {}): Promise<ReloadReport> {
		this.batch.assertOutside("reload");
		if (this.closing) return Promise.reject(this.#closedError());
		if (this.#status !== "loaded") throw new Error("reload runs after load");
		for (const { name } of facets) if (!isPluginName(name)) throw new Error(`"${name}" is not a valid plugin name`);
		const run = this.#reloadTail.then(async () => {
			if (untraced(context.telemetry)) return this.#reload(facets, context, options.failed ?? []);
			return context.telemetry.startSpan({ name: "objects.reload", attributes: { "objects.host": this.spanHost, plugins: facets.length } }, async (span) => {
				try {
					const result = await this.#reload(facets, withTelemetry(span, context), options.failed ?? []);
					span.setAttributes({ added: result.plugins.added.length, changed: result.plugins.changed.length, removed: result.plugins.removed.length, failed: result.failed.length, fates: result.objects.length });
					for (const { object, kind } of result.objects) span.addEvent("objects.reload.fate", { object: capped(object), fate: kind });
					return result;
				} catch (error) { ended(span, "reload_failed", error, context.abortSignal); throw error; }
			});
		});
		this.#reloadTail = run.then(
			() => {},
			() => {},
		);
		return run;
	}
	async #reload(
		facets: readonly PluginFacet<P>[],
		context: Context,
		before: readonly PluginFailure[],
	): Promise<ReloadReport> {
		this.#assertOpen();
		const aborted = (): ObjectsError => new ObjectsError({ code: "aborted", message: "reload: aborted" });
		if (context.abortSignal?.aborted) throw aborted();
		const { staged, added, changed, removed, failed, actions } = this.#reloadPlan(facets, before, context);
		const replaced = new Set([...changed, ...removed]),
			publishing = new Set([...added, ...changed]);
		if (context.abortSignal?.aborted) throw aborted();
		this.batch.commit(() => {
			for (const name of replaced) {
				const previous = this.#plugins.get(name)!;
				for (const registry of previous.declarations.registries.keys())
					if (staged.registries.get(registry)?.plugin !== name) this.registryRecord(registry).unserve();
				for (const contribution of previous.contributions) contribution.record.remove(contribution);
				this.#plugins.delete(name);
			}
			for (const [name, served] of this.#served) if (replaced.has(served.plugin)) this.#served.delete(name);
			for (const [name, served] of staged.types) if (publishing.has(served.plugin)) this.#served.set(name, served);
			this.#install(staged, publishing);
			for (const name of publishing)
				for (const registry of this.#plugins.get(name)!.declarations.registries.keys())
					this.registryRecord(registry).composeServed();
		}, context);
		for (const name of this.#presence.keys()) if (!this.#served.has(name)) this.#presence.delete(name);
		for (const record of this.#registries.values()) record.reportUndeclared();
		const attempts = new Map<ObjectsObject, ReturnType<ObjectsObject["reload"]>>();
		for (const action of actions) {
			if (action.kind !== "end") attempts.set(action.object, action.object.reload(action.served, action.kind, action.requests));
			else action.object.remove({ kind: "waiting", error: new ObjectsError({ code: "unavailable", message: `${action.object.served.contract.name} is not served here` }) });
		}
		for (const action of actions) action.object.startSuccessor();
		const checks = actions.map(async (action): Promise<ReloadedObject> => {
			const { object } = action;
			if (action.kind === "end") return { object: object.label, kind: "ended" };
			const cause = await (action.kind === "restart" || object.openOldAttempt !== undefined ? object.readinessCause : attempts.get(object)!.checked);
			return cause === undefined
				? { object: object.label, kind: action.kind === "restart" ? "restarted" : "retried" }
				: { object: object.label, kind: "parked", cause };
		});
		for (const served of this.#served.values())
			if (served.kind === "local" && served.hostLifetime)
				this.#object(served, { params: {}, key: "" }, undefined, context);
		this.#requests.wake([
			...[...staged.types.values()]
				.filter((served) => publishing.has(served.plugin))
				.map((served) => served.contract.name),
			...[...staged.registries].filter(([, entry]) => publishing.has(entry.plugin)).map(([name]) => name),
		]);
		const objects = await this.#reloadResults(
			checks,
			{
				added,
				changed,
				removed,
				failed: failed.map(({ plugin }) => plugin),
			},
			context,
		);
		return { plugins: { added, changed, removed }, failed, objects };
	}
	async #reloadResults(
		checks: readonly Promise<ReloadedObject>[],
		committed: CommittedReload,
		context: Context,
	): Promise<ReloadedObject[]> {
		try {
			return await awaitWithContext(Promise.all(checks), context);
		} catch {
			throw new ObjectsError({
				code: "aborted",
				message: "reload: aborted after its commit",
				details: {
					committed: {
						added: [...committed.added],
						changed: [...committed.changed],
						removed: [...committed.removed],
						failed: [...committed.failed],
					},
				},
			});
		}
	}
	#install(staged: Staged<P>, names: Iterable<string>): void {
		for (const name of names) {
			const plugin = staged.plugins.get(name)!;
			for (const [key, item] of plugin.registries) this.registryRecord(key).serve(item.token.version, item.provider);
			const contributions = plugin.contributions.map(({ registry, value }) =>
				contributionOf(this.registryRecord(registry.name), { plugin: name, type: undefined }, registry.version, value),
			);
			for (const contribution of contributions) contribution.record.add(contribution);
			this.#plugins.set(name, { facet: plugin.facet, declarations: plugin, contributions });
		}
	}
	#assertOpen(): void {
		if (this.closing) throw this.#closedError();
	}
	#assertLoadCalled(name: string): void {
		if (this.#status === "new")
			throw new ObjectsError({
				code: "not_ready",
				message: `${name}: the host has not loaded; call host.load first (a host with nothing to load calls load([]))`,
			});
	}
	#closedError(): ObjectsError {
		return new ObjectsError({ code: "released", reason: "closed", message: "the host is closed" });
	}
}
function missing(
	served: Served | undefined,
	kind: Contract["kind"],
	name: string,
	version: number,
	fingerprint: string,
): FailureCause | undefined {
	if (!served || served.kind !== kind)
		return { kind: "waiting", error: new ObjectsError({ code: "unavailable", message: `${name} is not served here` }) };
	if (!binds(served.provider, version, fingerprint))
		return {
			kind: "waiting",
			error: new ObjectsError({
				code: "contract_mismatch",
				message: `${name} v${version} does not match the served v${served.contract.version}`,
			}),
		};
	return undefined;
}
async function waitForRegistry(value: RegistryValueSource, usable: () => boolean, context: Context): Promise<void> {
	let change = Promise.withResolvers<void>();
	const release = value.wait({
		dependencyMoved: () => queueMicrotask(() => change.resolve()),
		closed: (error) => change.reject(error),
	});
	try {
		while (!usable()) {
			await awaitWithContext(change.promise, context);
			change = Promise.withResolvers<void>();
		}
	} finally {
		release();
	}
}
