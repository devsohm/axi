import {
	awaitWithContext,
	withAbortSignal,
	withContextValue,
	createContextKey,
	withTelemetry,
	type Context,
} from "../context/index.ts";
import type { TelemetryContext, TelemetrySpan } from "@axi/telemetry";
import { OpenSpan, objectsMetrics, spanFailed, untraced } from "../telemetry.ts";
import type { JsonValue } from "../json.ts";
import type { NativeWatchable, Watchable, WatchEnd } from "../watch.ts";
import type { Contract, Implementation, ParamsOf } from "../contracts/index.ts";
import { contractData, type ShapeOf } from "../contracts/internal.ts";
import { ObjectsError, type FailureCause, type Principal } from "../data/index.ts";
import { asObjectsError, checkArgs, checkParams, invalid, openFailure, type Provider } from "../data/internal.ts";
import type { HandleOf, JsonObject, StateDefinition, Tx } from "../documents/index.ts";
import {
	SealToken,
	type AnyDefinition,
	type Documents,
	type KeyDeclarer,
	type KeyedSlot,
	type KeySource,
} from "../documents/internal.ts";
import type { JobDefinition, JobHandle, JobImplementation } from "../jobs/index.ts";
import { Job, type AnyJobImplementation } from "../jobs/internal.ts";
import type { JobRecords } from "../jobs/records.ts";
import type { Contribution, Registry, RegistryValue } from "../registries/index.ts";
import {
	type RegistryValueSource,
	type RegistryContribution,
	type RegistryRecord,
	type RegistryWaiter,
} from "../registries/internal.ts";
import type { Writable } from "../state/index.ts";
import { Derive, WritableSource, type Batch, type DeriveSource } from "../state/internal.ts";
import type { Columns, RowOf } from "../store/columns.ts";
import { checkLiveQuery, LiveQueries, LiveQuery } from "../store/live-query.ts";
import type { Query } from "../store/query.ts";
import { tableSqlName } from "../store/sql.ts";
import type { ObjectsStore } from "../store/store.ts";
import type { TableDefinition } from "../store/table.ts";
import { TableHandle, type Table } from "../store/table-handle.ts";
import { prepareTables } from "../store/table-migration.ts";
import { CallContext, withLinkedAbortSignal, type Acquirer, type Caller, type Ctx, type GetOptions } from "./ctx.ts";
import { AdaptedMembers } from "./adapted.ts";
import { Deadline } from "./deadline.ts";
import { checkDependencies, parkedCause, ParkedLong, waitingOn, type Dependency } from "./dependencies.ts";
import { FollowSource, type FollowAttach } from "./follow.ts";
import { attachDerives, checkImplementation, contributionOf, type KeyedBinding, type Members } from "./members.ts";
import {
	NativeHandle,
	drained,
	type CloseFailed,
	type Native,
	type NativeCloseReason,
	type NativeOptions,
	type NativeSlot,
} from "./native.ts";
import type { Failed, RefState } from "./ref-state.ts";
import type { Binding, CheckedParams, LocalTarget, Reference, RetryOperation, Target } from "./reference.ts";
import type { HostError } from "./report.ts";
import { retrySource, type RetrySource } from "./retry-on.ts";
import {
	Routines,
	type OnHandler,
	type OnLiveHandler,
	type OnNativeHandler,
	type RoutineDeclarations,
} from "./routines.ts";

type SourceValues<S extends readonly unknown[]> = {
	readonly [I in keyof S]: S[I] extends Watchable<infer V> ? V : S[I] extends NativeWatchable<infer V> ? V : never;
};
export interface Self<P extends Principal = Principal> extends RoutineDeclarations<P> {
	state<D extends StateDefinition<JsonObject, boolean, false>>(definition: D): HandleOf<D>;
	derive<const S extends readonly (Watchable<unknown> | NativeWatchable<unknown>)[], T extends JsonValue>(
		sources: S,
		compute: (
			values: {
				readonly [I in keyof S]: S[I] extends Watchable<infer V>
					? V
					: S[I] extends NativeWatchable<infer V>
						? V
						: never;
			},
		) => T,
	): Watchable<T>;
	get<C extends Contract>(type: C, params: ParamsOf<C>): Reference<C>;
	registry<C, V>(registry: Registry<C, V>): RegistryValue<V>;
	writable<T>(initial: T): Writable<T>;
	retryOn(...sources: readonly (Watchable<unknown> | NativeWatchable<unknown>)[]): void;
	open<T>(
		open: (context: Context) => Promise<T>,
		close: (value: T, reason: NativeCloseReason, context: Context) => void | Promise<void>,
		options?: NativeOptions,
	): Native<T>;
	tx<R>(fn: (tx: Tx) => R | Promise<R>, context: Context): Promise<R>;
	follow<T>(attach: FollowAttach<T>): Watchable<T>;
	job<A, R, S>(definition: JobDefinition<A, R, S>, implementation: JobImplementation<A, R, S, P>): JobHandle<A, R, S>;
}
export interface StoreSelf<P extends Principal = Principal> extends Self<P> {
	state<D extends StateDefinition<JsonObject, boolean, boolean>>(definition: D): HandleOf<D>;
	table<C extends Columns, K extends readonly string[]>(definition: TableDefinition<C, K>): Table<C, K>;
	query<C extends Columns, K extends readonly string[]>(table: Table<C, K>, query: Query<C, K>, limit: number): Watchable<RowOf<C>[]>;
	contribute<C>(registry: Registry<C, unknown>, value: Contribution<C>): void;
}
export type Factory<C extends Contract, P extends Principal = Principal> = ShapeOf<C>["kind"] extends "local"
	? (params: ParamsOf<C>, self: keyof ParamsOf<C> extends never ? StoreSelf<P> : Self<P>) => Implementation<C, Ctx<P>>
	: (params: ParamsOf<C>, principal: P, self: Self<P>) => Implementation<C, Ctx<P>>;

export type AttemptHost = Acquirer & {
	readonly telemetry?: import("@axi/telemetry").TelemetryContext;
	principalAttributes?(principal: Principal | undefined, context: Context): Readonly<import("@axi/telemetry").SpanAttributes>;
	readonly batch: Batch;
	readonly principal: Principal | undefined;
	readonly incarnation: string;
	readonly timeouts: { readonly ready: number; readonly close: number };
	readonly store: ObjectsStore | undefined;
	count(kind: "calls" | "jobs" | "references" | "lingering", delta: number): void;
	report(error: HostError): void;
	reference(type: Contract, dependent: LocalTarget | undefined, caller: Caller, options: GetOptions): Binding;
	bind(binding: Binding, type: Contract, params: CheckedParams, context: Context): void;
	registryRecord(name: string): RegistryRecord;
};
type ServingBase = { readonly contract: Contract; readonly provider: Provider<Contract>; readonly plugin: string; readonly traced?: boolean };
export type AttemptServing = ServingBase &
	(
		| {
				readonly kind: "local";
				readonly hostLifetime: boolean;
				readonly factory: (params: ParamsOf<Contract>, self: Self) => unknown;
		  }
		| {
				readonly kind: "remote";
				readonly factory: (params: ParamsOf<Contract>, principal: Principal, self: Self) => unknown;
		  }
	);
export interface AttemptObject extends LocalTarget {
	readonly host: AttemptHost;
	readonly served: AttemptServing;
	readonly documents: Documents;
	readonly liveQueries: LiveQueries;
	readonly params: ParamsOf<Contract>;
	readonly principal: Principal | undefined;
	claimDocuments(namespace: string): void;
	claimTable(table: string): void;
	jobRecords(definition: JobDefinition<unknown, unknown, unknown>): JobRecords;
	failLive(attempt: Attempt, cause: FailureCause): void;
	retryOn(sources: readonly RetrySource[]): void;
	assertNoCycle(target: Target, context: Context): void;
	waitsFor(dependencies: readonly Dependency[]): void;
	parked(attempt: Attempt, state: RefState, firstPass: boolean): void;
	unparked(attempt: Attempt): void;
	ended(): ObjectsError;
}
type Activation =
	| { readonly kind: "live" }
	| { readonly kind: "failed"; readonly cause: FailureCause }
	| { readonly kind: "ended"; readonly error: ObjectsError };
type NotLive = Exclude<Activation, { readonly kind: "live" }>;
type RegistryDeclarations = {
	readonly registries: RegistryValueSource[];
	readonly reads: (() => void)[];
	readonly retry: RetrySource[];
	readonly writables: { detach(error: Error): void }[];
	readonly declared: { readonly registry: Registry<unknown, unknown>; readonly value: unknown }[];
	contributions: readonly RegistryContribution[];
};
const none: readonly never[] = [];
const routineToken = createContextKey<SealToken>("routine");
export function notLive(label: string, ms: number): ObjectsError {
	return new ObjectsError({ code: "unavailable", message: `${label}: did not become live within ${ms} ms` });
}

export class Attempt implements StoreSelf, KeyDeclarer, RegistryWaiter {
	readonly #object: AttemptObject;
	readonly #served: AttemptServing;
	readonly #adapted = new Map<number, AdaptedMembers>();
	readonly #context: Context;
	readonly #abort = new AbortController();
	#opening: Context;
	readonly #trace: { readonly attempt: number; readonly trigger: TelemetryContext };
	#activation?: OpenSpan;
	#parkedAt?: number;
	readonly #token = new SealToken();
	readonly #routineToken = new SealToken();
	readonly #routineAbort = new AbortController();
	readonly #checked = Promise.withResolvers<FailureCause | undefined>();
	readonly #runs = new Map<Promise<unknown>, (() => void) | undefined>();
	#reloadStarted = false;
	readonly #routineCalls = new Set<Promise<unknown>>();
	#drainReported = false;
	readonly #declared = new Map<string, AnyDefinition>();
	readonly #pins: (() => void)[] = [];
	readonly #derives: Derive[] = [];
	readonly #follows: FollowSource[] = [];
	readonly #routines = new Routines();
	readonly #jobs = new Map<string, Job>();
	readonly #tables = new Map<string, TableHandle>();
	readonly #queries: LiveQuery[] = [];
	readonly #references: { readonly binding: Binding; readonly contract: Contract; readonly params: CheckedParams }[] =
		[];
	readonly #dependencies: Dependency[] = [];
	readonly #natives: NativeSlot[] = [];
	readonly #running = new Map<Promise<unknown>, (() => void) | undefined>();
	#declaring = false;
	#live = false;
	#members: Members | undefined;
	#variant: string | undefined;
	#abandoned: NotLive | undefined;
	#parked: readonly Dependency[] | undefined;
	#moved = false;
	#change: PromiseWithResolvers<void> | undefined;
	#early: ObjectsError | undefined;
	#registry: RegistryDeclarations | undefined;
	constructor(object: AttemptObject, context: Context, trace: { readonly attempt: number; readonly trigger: TelemetryContext } = { attempt: 1, trigger: context.telemetry }) {
		this.#object = object;
		this.#served = object.served;
		this.#context = context;
		this.#trace = trace;
		this.#opening = withAbortSignal(this.#abort.signal, context);
	}
	state<D extends StateDefinition<JsonObject, boolean, boolean>>(definition: D): HandleOf<D> {
		this.#declaringOnly("state");
		const name = definition.name;
		if (this.#declared.has(name)) throw new Error(`${this.#object.label}: state "${name}" is declared twice`);
		if (definition.persist) {
			this.#persistable(`state "${name}"`);
			this.#object.claimDocuments("objects");
		}
		this.#declared.set(name, definition);
		return this.#object.documents.declare(definition, this.#token, this);
	}
	at(slot: KeyedSlot, key: string): KeySource {
		this.#declaringOnly("state(...).at");
		this.#pins.push(slot.pin(key, this.#opening));
		return slot.source(key);
	}
	table<C extends Columns, K extends readonly string[]>(definition: TableDefinition<C, K>): Table<C, K> {
		this.#declaringOnly("table");
		const object = this.#object,
			name = definition.name,
			store = this.#persistable(`table "${name}"`);
		if (this.#tables.has(name)) throw new Error(`${object.label}: table "${name}" is declared twice`);
		const sql = tableSqlName(this.#served.contract.name, name);
		object.claimTable(sql);
		const handle = new TableHandle(definition as unknown as TableDefinition, sql, store, {
			label: object.label,
			queries: object.liveQueries,
			scope: object.documents,
			assertLive: () => object.documents.assertLive(),
			fail: (error) => object.failLive(this, { kind: "broken", error }),
		});
		this.#tables.set(name, handle);
		return handle as unknown as Table<C, K>;
	}
	query<C extends Columns, K extends readonly string[]>(table: Table<C, K>, query: Query<C, K>, limit: number): Watchable<RowOf<C>[]> {
		this.#declaringOnly("query");
		const handle: unknown = table;
		const { label, host } = this.#object;
		if (!(handle instanceof TableHandle) || this.#tables.get(handle.definition.name) !== handle)
			throw new Error(`${label}: self.query: the table is not one this factory declared`);
		checkLiveQuery(handle.definition, query as unknown as Query, limit, label);
		const live = new LiveQuery(handle, query as unknown as Query, limit, {
			label, report: (error) => host.report({ kind: "query_failed", object: label, table: handle.definition.name, error }),
		}, host.batch);
		handle.owner.queries.add(live);
		this.#queries.push(live);
		return live as unknown as Watchable<RowOf<C>[]>;
	}
	derive<const S extends readonly (Watchable<unknown> | NativeWatchable<unknown>)[], T extends JsonValue>(
		sources: S,
		compute: (values: SourceValues<S>) => T,
	): Watchable<T> {
		this.#declaringOnly("derive");
		const derive = new Derive(sources, compute as (values: readonly unknown[]) => T, this.#object.host.batch);
		this.#derives.push(derive);
		return derive as unknown as Watchable<T>;
	}
	get<C extends Contract>(type: C, params: ParamsOf<C>): Reference<C> {
		this.#declaringOnly("get");
		const checked = checkParams(type, params, this.#opening),
			binding = this.#object.host.reference(type, this.#object, this.#caller(), {});
		this.#references.push({ binding, contract: type, params: checked });
		this.#dependencies.push({ kind: "reference", binding });
		return binding.reference as Reference<C>;
	}
	registry<C, V>(registry: Registry<C, V>): RegistryValue<V> {
		this.#declaringOnly("registry");
		const value = this.#object.host.registryRecord(registry.name).value(registry.version);
		this.#declarations().registries.push(value);
		this.#dependencies.push({ kind: "registry", value });
		return value as RegistryValue<V>;
	}
	writable<T>(initial: T): Writable<T> {
		this.#declaringOnly("writable");
		const writable = new WritableSource(
			initial,
			{
				context: this.#context,
				assertUsable: () => {
					if (this.#token.sealed) throw this.#object.ended();
				},
			},
			this.#object.host.batch,
		);
		this.#declarations().writables.push(writable);
		return writable;
	}
	retryOn(...sources: readonly (Watchable<unknown> | NativeWatchable<unknown>)[]): void {
		this.#declaringOnly("retryOn");
		for (const source of sources) this.#declarations().retry.push(retrySource(source, this.#object.label));
	}
	contribute<C>(registry: Registry<C, unknown>, value: Contribution<C>): void {
		this.#declaringOnly("contribute");
		const object = this.#object;
		if (this.#served.kind !== "local" || !this.#served.hostLifetime)
			throw new Error(`${object.label}: self.contribute is valid only in a local type with empty params`);
		const declarations = this.#declarations();
		if (declarations.declared.some((item) => item.registry.name === registry.name))
			throw new Error(`${object.label}: registry ${registry.name} is contributed to twice`);
		declarations.declared.push({ registry: registry as Registry<unknown, unknown>, value });
	}
	open<T>(
		open: (context: Context) => Promise<T>,
		close: (value: T, reason: NativeCloseReason, context: Context) => void | Promise<void>,
		options: NativeOptions = {},
	): Native<T> {
		this.#declaringOnly("open");
		const object = this.#object,
			native = new NativeHandle(open, close, options.closeTimeout ?? object.host.timeouts.close, {
				object: object.label,
				type: this.#served.contract.name,
				host: object.host.spanHost,
				telemetry: object.host.telemetry,
				position: this.#natives.length + 1,
				context: this.#context,
				report: (error) => object.host.report(error),
			});
		this.#natives.push(native);
		return native;
	}
	tx<R>(fn: (tx: Tx) => R | Promise<R>, context: Context): Promise<R> {
		return this.#object.documents.tx(fn, context.value(routineToken) ?? this.#token, context);
	}
	follow<T>(attach: FollowAttach<T>): Watchable<T> {
		this.#declaringOnly("follow");
		const object = this.#object,
			source = new FollowSource(
				attach as unknown as FollowAttach<JsonValue>,
				{ label: object.label, context: this.#context, ended: (end) => this.#followEnded(end) },
				object.host.batch,
			);
		this.#follows.push(source);
		return source as unknown as Watchable<T>;
	}
	on<T>(source: Watchable<T>, fn: OnHandler<T>): void;
	on<T>(source: NativeWatchable<T>, fn: OnNativeHandler<T>): void;
	on(source: Watchable<unknown> | NativeWatchable<unknown>, fn: (...args: never[]) => void | Promise<void>): void {
		this.#declaringOnly("on");
		this.#routines.on(source, fn);
	}
	onLive(fn: OnLiveHandler): void {
		this.#declaringOnly("onLive");
		this.#routines.onLive(fn);
	}
	job<A, R, S>(definition: JobDefinition<A, R, S>, implementation: JobImplementation<A, R, S>): JobHandle<A, R, S> {
		this.#declaringOnly("job");
		const object = this.#object;
		if (this.#jobs.has(definition.name)) throw new Error(`${object.label}: job "${definition.name}" is declared twice`);
		if (definition.persist) {
			this.#persistable(`job "${definition.name}"`);
			object.claimDocuments("objects.jobs");
			object.claimDocuments("objects.job-states");
		}
		const records = object.jobRecords(definition as JobDefinition<unknown, unknown, unknown>);
		const job = new Job(records, implementation as unknown as AnyJobImplementation, {
			host: object.host,
			caller: this.#caller(),
			context: this.#context,
			signal: this.#abort.signal,
			token: this.#token,
			documents: object.documents,
			admit: (work, cleanup) => this.#admit(work, cleanup),
			admitRun: (work, cleanup) => this.#admit(work, cleanup, true),
		});
		this.#jobs.set(definition.name, job);
		return job as unknown as JobHandle<A, R, S>;
	}
	get isParked(): boolean {
		return this.#parked !== undefined;
	}
	get contributions(): readonly RegistryContribution[] {
		return this.#registry?.contributions ?? none;
	}
	get variant(): string | undefined {
		return this.#variant;
	}
	get stateMembers(): ReadonlyMap<string, DeriveSource> {
		return this.#members!.state;
	}
	get keyedMembers(): ReadonlyMap<string, KeyedBinding> {
		return this.#members!.keyed;
	}

	member(name: string): DeriveSource {
		const source = this.#members!.state.get(name);
		if (!source)
			throw invalid(
				"member",
				`${this.#object.label}${this.#variant === undefined ? "" : ` (variant ${this.#variant})`} has no state member "${name}"`,
			);
		return source;
	}
	keyedMember(name: string): KeyedSlot {
		const keyed = this.#members!.keyed.get(name);
		if (!keyed) throw invalid("member", `${this.#object.label} has no keyed member "${name}"`);
		return keyed.kind === "own" ? keyed.slot : keyed.binding.keyedSlot(keyed.member);
	}
	async call(
		method: string,
		args: unknown,
		context: Context,
		caller: Caller,
		version = this.#served.contract.version,
		parent: import("@axi/telemetry").TelemetryContext = context.telemetry,
	): Promise<unknown> {
		context.abortSignal?.throwIfAborted();
		const object = this.#object,
			host = object.host,
			own = this.#members!.methods.get(method);
		if (own === undefined && version === this.#served.contract.version) throw this.#missingMethod(method);
		const checked = checkArgs(this.#served.provider, method, args, version, context),
			handler =
				checked.kind === "call"
					? (value: unknown, ctx: Context) => checked.call(value as Parameters<typeof checked.call>[0], ctx)
					: own;
		if (!handler) throw this.#missingMethod(method);
		const linked = withLinkedAbortSignal(this.#abort.signal, context);
		const acting = this.#served.kind === "remote" ? caller : { principal: host.principal, incarnation: host.incarnation };
		const span = this.#served.traced !== false && !untraced(parent) ? new OpenSpan(parent, "objects.method", {
			"objects.host": host.spanHost, type: this.#served.contract.name, member: method, object: object.label.slice(0, 256),
			"principal.kind": (acting.principal?.kind ?? "none").slice(0, 256),
			...host.principalAttributes?.(acting.principal, context),
		}) : undefined;
		const ctx = new CallContext(span ? withTelemetry(span.span, linked.context) : linked.context, acting, host);
		const running = Promise.withResolvers<unknown>();
		const inFlight = objectsMetrics(host.telemetry?.metrics).upDownCounter("objects.calls.in_flight");
		inFlight.add(1);
		host.count("calls", 1);
		this.#admit(running.promise, () => {
			host.count("calls", -1);
			inFlight.add(-1);
			linked.release();
			ctx.settle();
		});
		span?.endWhen(running.promise, "method_failed", linked.context.abortSignal);
		(async () => handler(checked.args, ctx))().then(running.resolve, running.reject);
		const result = await awaitWithContext(running.promise, linked.context);
		return checked.kind === "method" && checked.result !== undefined
			? checked.result(result as Parameters<typeof checked.result>[0])
			: result;
	}
	#missingMethod(method: string): ObjectsError {
		return invalid(
			"member",
			`${this.#object.label}${this.#variant === undefined ? "" : ` (variant ${this.#variant})`} has no method "${method}"`,
		);
	}
	memberAt(name: string, version: number): DeriveSource {
		return version === this.#served.contract.version ? this.member(name) : this.#adaptedAt(version).member(name);
	}
	keyMapping(name: string, version: number): ((value: JsonValue) => JsonValue) | undefined {
		return version === this.#served.contract.version ? undefined : this.#adaptedAt(version).keyed(name);
	}
	mapKey(name: string, source: DeriveSource, version: number): { readonly source: DeriveSource; release(): void } {
		return version === this.#served.contract.version
			? { source, release() {} }
			: this.#adaptedAt(version).key(name, source);
	}
	dropVersion(version: number): void {
		this.#adapted.get(version)?.detach(this.#object.ended());
		this.#adapted.delete(version);
	}
	#adaptedAt(version: number): AdaptedMembers {
		let adapted = this.#adapted.get(version);
		if (adapted === undefined) {
			const object = this.#object;
			adapted = new AdaptedMembers(
				{
					served: this.#served,
					variant: this.#variant,
					label: object.label,
					batch: object.host.batch,
					member: (name) => this.member(name),
					report: (member, error) => object.host.report({ kind: "derive_failed", object: object.label, member, error }),
				},
				version,
			);
			this.#adapted.set(version, adapted);
		}
		return adapted;
	}
	async activate(previous: Promise<void> | undefined): Promise<Activation> {
		this.#startSpan(this.#trace.trigger);
		const budget = this.#object.host.timeouts.ready,
			deadline = new Deadline(budget, () =>
				this.abandon({ kind: "failed", cause: { kind: "transient", error: notLive(this.#object.label, budget) } }),
			);
		try {
			if (previous) {
				try {
					await awaitWithContext(previous, this.#opening);
				} catch {
					return this.#abandoned!;
				}
			}
			return await this.#activate(deadline);
		} finally {
			deadline.clear();
			this.#checked.resolve(undefined);
		}
	}
	get activationSpan(): TelemetrySpan | undefined { return this.#activation?.span; }
	activated(outcome: Activation, retryAt?: number): void {
		if (!this.#activation) return;
		if (this.#activation.ended) {
			if (outcome.kind === "live") return;
			this.#startSpan(this.#activation.span);
		}
		const { span } = this.#activation;
		span.setAttributes({ outcome: outcome.kind });
		if (outcome.kind === "failed") {
			spanFailed(span, "activation_failed", outcome.cause.error);
			if (retryAt !== undefined) span.addEvent("objects.retry", { backoff: Math.max(0, retryAt - Date.now()) });
		}
		this.#activation.end();
	}
	#startSpan(trigger: TelemetryContext): void {
		const { host, label } = this.#object;
		if (!host.telemetry || untraced(host.telemetry)) return;
		this.#activation = new OpenSpan(host.telemetry, "objects.activate", {
			"objects.host": host.spanHost, type: this.#served.contract.name, object: label.slice(0, 256), attempt: this.#trace.attempt,
		});
		if (!untraced(trigger)) this.#activation.span.addLink({ context: trigger });
		this.#opening = withTelemetry(this.#activation.span, this.#opening);
	}
	#parkSpan(shown: RefState): void {
		this.#parkedAt ??= performance.now();
		if (!this.#activation || this.#activation.ended) return;
		this.#activation.span.addEvent("objects.park", { cause: shown.kind === "failed" ? shown.cause.error.message.slice(0, 500) : "loading" });
		this.#activation.span.setAttributes({ outcome: "parked" });
		this.#activation.end();
	}
	#leavePark(): void {
		if (this.#parkedAt === undefined) return;
		objectsMetrics(this.#object.host.telemetry?.metrics).histogram("objects.park.duration").record(performance.now() - this.#parkedAt);
		this.#parkedAt = undefined;
	}
	abandon(outcome: NotLive): void {
		if (!this.#abandoned) {
			this.#abandoned = outcome;
			this.#checked.resolve(outcome.kind === "failed" ? outcome.cause : undefined);
			this.#abort.abort(outcome.kind === "ended" ? outcome.error : outcome.cause.error);
		}
	}
	startedByReload(): void {
		this.#reloadStarted = true;
	}
	get reloadStarted(): boolean {
		return this.#reloadStarted;
	}
	declaresJob(name: string): boolean {
		return this.#jobs.has(name);
	}
	get opensNatives(): boolean {
		return this.#natives.length > 0;
	}
	get checked(): Promise<FailureCause | undefined> {
		return this.#checked.promise;
	}
	live(routinesAfter?: Promise<void>): void {
		this.#live = true;
		if (this.#early) {
			this.#object.failLive(this, { kind: "transient", error: this.#early });
			return;
		}
		for (const job of this.#jobs.values()) job.live();
		const start = (): void => {
			if (!this.#abort.signal.aborted)
				this.#routines.start({
					type: this.#served.contract.name,
					label: this.#object.label,
					host: this.#object.host,
					caller: this.#caller(),
					context: withContextValue(
						routineToken,
						this.#routineToken,
						withAbortSignal(this.#routineAbort.signal, this.#context),
					),
					admit: (work, cleanup) => {
						this.#routineCalls.add(work);
						this.#admit(work, () => {
							this.#routineCalls.delete(work);
							cleanup();
						});
					},
				});
		};
		if (routinesAfter) void routinesAfter.then(start);
		else start();
	}
	seal(error: ObjectsError, reason: "restart" | "reload" = "restart"): void {
		this.stopRoutines();
		this.#object.documents.fence(this.#routineToken);
		this.abandon({ kind: "ended", error });
		this.#object.documents.fence(this.#token);
		for (const job of this.#jobs.values()) job.seal(error, reason);
	}
	stopRoutines(): void {
		this.#routineAbort.abort(this.#object.ended());
	}
	handOver(): void {
		this.stopRoutines();
		for (const job of this.#jobs.values()) job.handOver();
	}
	async drainCalls(): Promise<void> {
		await this.#drain(new Set([...this.#running.keys(), ...this.#routineCalls]));
	}
	async drainRoutines(): Promise<void> {
		await this.#drain(this.#routineCalls);
		this.#object.documents.fence(this.#routineToken);
	}
	async #drain(work: Iterable<Promise<unknown>>): Promise<void> {
		const all = [...work];
		if ((await drained(all, all.length, this.#object.host.timeouts.close)) === "timeout" && !this.#drainReported) {
			this.#drainReported = true;
			this.#object.host.report({ kind: "drain_timeout", object: this.#object.label });
		}
	}
	async close(reason: NativeCloseReason): Promise<CloseFailed[]> {
		if (
			(await drained(
				[...this.#running.keys(), ...this.#runs.keys()],
				this.#running.size + this.#runs.size,
				this.#object.host.timeouts.close,
			)) === "timeout" &&
			!this.#drainReported
		)
			this.#object.host.report({ kind: "drain_timeout", object: this.#object.label });
		for (const job of this.#jobs.values()) await job.writeAtClose(this.#context);
		for (const [work, cleanup] of this.#running) {
			this.#running.delete(work);
			cleanup?.();
		}
		const failures: CloseFailed[] = [];
		for (const native of this.#natives.toReversed()) {
			const failure = await native.close(reason);
			if (failure) failures.push(failure);
		}
		return failures;
	}
	detach(): void {
		const ended = this.#object.ended();
		for (const adapted of this.#adapted.values()) adapted.detach(ended);
		this.#adapted.clear();
		for (const derive of this.#derives) derive.detach(ended);
		for (const query of this.#queries) query.detach(ended);
		for (const follow of this.#follows) follow.detach();
		for (const writable of this.#registry?.writables ?? none) writable.detach(ended);
	}
	releaseReferences(): void {
		for (const { binding } of this.#references) binding.release();
		for (const release of this.#registry?.reads.splice(0) ?? none) release();
	}
	dependencyMoved(): void {
		if (!this.#moved) {
			this.#moved = true;
			if (this.#change) queueMicrotask(() => this.#change?.resolve());
		}
	}
	closed(error: ObjectsError): void {
		this.abandon({ kind: "ended", error });
	}
	retryDependencies(operation: RetryOperation): void {
		for (const dependency of this.#parked ?? none)
			if (dependency.kind === "reference" && dependency.binding.refState.kind === "failed")
				dependency.binding.retry(operation);
		this.dependencyMoved();
	}
	async #activate(deadline: Deadline): Promise<Activation> {
		let implementation: unknown;
		const dependencies: Dependency[] = [];
		try {
			implementation = this.#declare();
			const object = this.#object,
				host = object.host;
			object.retryOn(this.#registry?.retry ?? none);
			object.documents.hydrate(this.#declared, this.#pins.splice(0), this.#opening);
			const loading = object.documents.load(this.#opening);
			if (loading) await loading;
			if (this.#tables.size) {
				const tables = [...this.#tables.values()];
				deadline.pause();
				try {
					await prepareTables(
						tables.map((handle) => ({ definition: handle.definition, table: handle.sql.table })),
						tables[0]!.store,
						{ admit: () => !this.#token.sealed && !this.#abandoned, adopt() {} },
						object.label,
						this.#opening,
					);
				} finally {
					deadline.resume();
				}
			}
			for (const query of this.#queries) await query.load(this.#opening);
			for (const job of this.#jobs.values()) await job.load(this.#opening);
			for (const { binding, contract, params } of this.#references) {
				host.bind(binding, contract, params, this.#opening);
			}
			dependencies.push(...this.#dependencies);
			for (const dependency of dependencies)
				if (dependency.kind === "reference" && dependency.binding.target)
					object.assertNoCycle(dependency.binding.target, this.#opening);
			for (const value of this.#registry?.registries ?? none) {
				this.#registry!.reads.push(value.read());
			}
		} catch (error) {
			return this.#broken(error);
		}
		if (
			(dependencies.length && checkDependencies(dependencies).kind !== "live") ||
			this.#references.some(({ binding }) => binding.pinsKeys)
		) {
			const outcome = await this.#park(dependencies, deadline);
			if (outcome) return outcome;
		} else {
			this.#checked.resolve(undefined);
			await undefined;
		}
		return this.#ownSteps(implementation);
	}
	async #park(dependencies: readonly Dependency[], deadline: Deadline): Promise<NotLive | undefined> {
		deadline.pause();
		this.#parked = dependencies;
		this.#object.waitsFor(dependencies);
		const waits = dependencies.flatMap((dependency) =>
				dependency.kind === "registry" ? [dependency.value.wait(this)] : [],
			),
			long = new ParkedLong(this.#object);
		try {
			while (true) {
				this.#moved = false;
				const check = checkDependencies(dependencies);
				if (check.kind === "parked") this.#checked.resolve(parkedCause(check));
				if (check.kind === "broken") return this.#broken(check.error);
				if (check.kind === "live") {
					this.#checked.resolve(undefined);
					const pending = this.#references.find(({ binding }) => binding.pinsKeys);
					if (pending) long.blockedBy({ label: pending.binding.label, state: "loading" });
					const failed = await this.#pinKeys();
					if (this.#abandoned) return this.#abandoned;
					if (!failed && !this.#moved) {
						this.#checked.resolve(undefined);
						this.#object.unparked(this);
						this.#leavePark();
						if (this.#activation?.ended) this.#startSpan(this.#activation.span);
						return;
					}
					if (failed) {
						this.#checked.resolve(failed.cause);
						this.#object.parked(this, failed, true);
						this.#parkSpan(failed);
					}
					long.stop();
				} else {
					this.#object.parked(this, check.shown, check.firstPass);
					this.#parkSpan(check.shown);
					long.blockedBy(check.blocker);
				}
				if (!(await this.#nextChange())) return this.#abandoned!;
			}
		} finally {
			this.#leavePark();
			long.stop();
			for (const release of waits) release();
			this.#parked = undefined;
			this.#object.waitsFor(none);
			deadline.resume();
		}
	}
	async #nextChange(): Promise<boolean> {
		if (this.#moved) return true;
		this.#change = Promise.withResolvers<void>();
		try {
			await awaitWithContext(this.#change.promise, this.#opening);
			return true;
		} catch {
			return false;
		} finally {
			this.#change = undefined;
		}
	}
	async #pinKeys(): Promise<Failed | undefined> {
		for (const { binding } of this.#references) {
			try {
				const pin = binding.pinKeys(this.#opening);
				if (pin) await pin;
			} catch (error) {
				return waitingOn(binding.label, asObjectsError(error, binding.label));
			}
		}
	}
	async #ownSteps(implementation: unknown): Promise<Activation> {
		for (const native of this.#natives) {
			if (this.#abandoned) return this.#abandoned;
			try {
				await awaitWithContext(native.open(this.#opening), this.#opening);
			} catch (error) {
				return this.#abandoned ?? { kind: "failed", cause: openFailure(error, this.#object.label) };
			}
		}
		for (const follow of this.#follows) {
			if (this.#abandoned) return this.#abandoned;
			try {
				await awaitWithContext(follow.attach(this.#opening), this.#opening);
			} catch (error) {
				return (
					this.#abandoned ?? {
						kind: "failed",
						cause: { kind: "transient", error: asObjectsError(error, this.#object.label) },
					}
				);
			}
		}
		try {
			const { members, variant } = checkImplementation(this.#served.contract, implementation);
			this.#members = members;
			this.#variant = variant;
			if (this.#registry) {
				const object = this.#object,
					contributor = { plugin: this.#served.plugin, type: this.#served.contract.name };
				this.#registry.contributions = this.#registry.declared.map(({ registry, value }) =>
					contributionOf(object.host.registryRecord(registry.name), contributor, registry.version, value),
				);
			}
			attachDerives(this.#derives, members.state, (member) => (error) => {
				if (this.#live)
					this.#object.host.report({
						kind: "derive_failed",
						object: this.#object.label,
						...(member === undefined ? {} : { member }),
						error,
					});
			});
			for (const derive of this.#derives) void derive.value;
		} catch (error) {
			return this.#broken(error);
		}

		return this.#abandoned ?? { kind: "live" };
	}
	#followEnded(end: WatchEnd): void {
		if (end.kind === "ended" && this.#live) return;
		const error =
			end.kind === "failed"
				? asObjectsError(end.error, this.#object.label)
				: new ObjectsError({
						code: "unavailable",
						message: `${this.#object.label}: a followed source ended while it activated`,
					});
		if (this.#live) this.#object.failLive(this, { kind: "transient", error });
		else {
			this.#early ??= error;
			this.abandon({ kind: "failed", cause: { kind: "transient", error } });
		}
	}
	#declare(): unknown {
		this.#declaring = true;
		try {
			const object = this.#object,
				served = this.#served;
			return served.kind === "local"
				? served.factory(object.params, this)
				: served.factory(object.params, object.principal!, this);
		} catch (error) {
			for (const release of this.#pins) release();
			throw error;
		} finally {
			this.#declaring = false;
		}
	}
	#persistable(what: string): ObjectsStore {
		const object = this.#object;
		if (this.#served.kind !== "local" || contractData(this.#served.contract).params.fields.length)
			throw new Error(`${object.label}: ${what}: persist needs a stable identity (a local type with empty params)`);
		if (!object.host.store) throw new Error(`${object.label}: ${what}: persist needs a store`);
		return object.host.store;
	}
	#admit(work: Promise<unknown>, cleanup?: () => void, run = false): void {
		const active = run ? this.#runs : this.#running;
		active.set(work, cleanup);
		const settled = (): void => {
			if (active.delete(work)) cleanup?.();
		};
		work.then(settled, settled);
	}
	#caller(): Caller {
		const { host, served, principal } = this.#object;
		return { principal: served.kind === "remote" ? principal : host.principal, incarnation: host.incarnation };
	}
	#broken(error: unknown): NotLive {
		const cause: FailureCause = { kind: "broken", error: asObjectsError(error, this.#object.label) };
		this.#checked.resolve(cause);
		return (
			this.#abandoned ?? { kind: "failed", cause: { kind: "broken", error: asObjectsError(error, this.#object.label) } }
		);
	}
	#declarations(): RegistryDeclarations {
		return (this.#registry ??= {
			registries: [],
			reads: [],
			retry: [],
			writables: [],
			declared: [],
			contributions: none,
		});
	}
	#declaringOnly(name: string): void {
		if (!this.#declaring) throw new Error(`${this.#object.label}: self.${name} is valid only in the factory`);
	}
}
