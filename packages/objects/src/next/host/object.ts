import type { Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import type { ContractShape } from "../contracts/internal.ts";
import { ObjectsError, type FailureCause, type Principal } from "../data/index.ts";
import { binds, invalid, sameCause } from "../data/internal.ts";
import { Documents, type KeyedSlot } from "../documents/internal.ts";
import type { JobDefinition } from "../jobs/index.ts";
import { JobRecords } from "../jobs/internal.ts";
import { CHAIN } from "../link/internal.ts";
import type { DeriveSource } from "../state/internal.ts";
import { Attempt, type AttemptHost, type AttemptServing } from "./attempt.ts";
import { refusal } from "./adapted.ts";
import type { Backoff } from "./backoff.ts";
import type { Caller } from "./ctx.ts";
import type { Dependency } from "./dependencies.ts";
import type { PinnedKey } from "./reference.ts";
import type { CloseFailed, NativeCloseReason } from "./native.ts";
import { LIVE, LOADING, type Ended, type Failed, type RefState } from "./ref-state.ts";
import { retryOperation, type LocalTarget, type Target } from "./reference.ts";
import { RetryWakes, type RetrySource } from "./retry-on.ts";
import type { Recorded } from "./staging.ts";
import { tableSqlName } from "../store/sql.ts";
import { uuidv7 } from "./uuid.ts";

export type LocalContract = Contract<ContractShape & { readonly kind: "local" }>;
export type RemoteContract = Contract<ContractShape & { readonly kind: "remote" }>;
export type Served = AttemptServing & { readonly linger: number };
export interface Holder {
	readonly following?: boolean;
	readonly version?: number;
	readonly fingerprint?: string;
	readonly dependent: LocalTarget | undefined;
	readonly caller: Caller;
	moved(): void;
	retarget?(): void;
	end(error: ObjectsError): void;
	removed?(cause: FailureCause): void;
	freeze?(): void;
}
export interface ObjectHost extends AttemptHost {
	readonly backoff: Backoff;
	referenced(object: ObjectsObject, holder: Holder, context: Context): void;
	unreferenced(object: ObjectsObject, holders: Iterable<Holder>, context: Context): void;
	endingOf(identity: string): Promise<void> | undefined;
	ending(identity: string, closing: Promise<void>): void;
	forget(object: ObjectsObject): void;
	wentLive(object: ObjectsObject): void;
	cycle(chain: readonly string[], instance: string, labels: readonly string[]): ObjectsError;
}
type Swap = { readonly old: Attempt; readonly done: PromiseWithResolvers<void>; parked: boolean };
type State =
	| { readonly kind: "waiting" }
	| { readonly kind: "activating"; readonly attempt: Attempt; readonly shown: RefState; readonly swap?: Swap }
	| { readonly kind: "live"; readonly attempt: Attempt }
	| { readonly kind: "failed"; readonly failure: Failed }
	| { readonly kind: "ended"; readonly state: Ended };
type Teardown =
	| { readonly kind: "none" }
	| { readonly kind: "end"; readonly previous: Promise<void> | undefined }
	| { readonly kind: "close"; readonly previous: Promise<void> | undefined; readonly attempt: Attempt };
const noDependencies: readonly Dependency[] = [];

export class ObjectsObject implements LocalTarget {
	readonly host: ObjectHost;
	served: Served;
	readonly params: ParamsOf<Contract>;
	readonly principal: Principal | undefined;
	readonly identity: string;
	readonly label: string;
	readonly chain: readonly string[];
	readonly documents: Documents;
	readonly #context: Context;
	readonly #jobs = new Map<string, JobRecords>();
	readonly #holders = new Set<Holder>();
	readonly #retiring = new Map<Attempt, Promise<void>>();
	#unbinding = false;
	#status: State = { kind: "waiting" };
	#instance: string | undefined;
	#waiting: readonly Dependency[] = noDependencies;
	#first: PromiseWithResolvers<void> | undefined;
	#passed = false;
	#lastFailure: ObjectsError | undefined;
	#linger: ReturnType<typeof setTimeout> | undefined;
	#runs = 0;
	#exposed: Attempt | undefined;
	#flush: { readonly deadline: number; readonly timer: ReturnType<typeof setTimeout> } | undefined;
	#wakes: RetryWakes | undefined;
	constructor(
		host: ObjectHost,
		served: Served,
		params: ParamsOf<Contract>,
		principal: Principal | undefined,
		key: string,
		identity: string,
		context: Context,
		chain: readonly string[],
	) {
		this.host = host;
		this.served = served;
		this.params = params;
		this.principal = principal;
		this.identity = identity;
		this.label = key ? `${served.contract.name}(${key})` : served.contract.name;
		this.chain = chain;
		this.#context = context;
		this.documents = new Documents({
			label: this.label,
			batch: host.batch,
			context,
			store: host.store && { store: host.store, owner: served.contract.name },
			fail: (error) => {
				if (this.#status.kind === "live") this.failLive(this.#status.attempt, { kind: "broken", error });
			},
		});
	}
	get state(): RefState {
		switch (this.#status.kind) {
			case "failed":
				return this.#status.failure;
			case "live":
				return LIVE;
			case "ended":
				return this.#status.state;
			case "activating":
				return this.#status.shown;
			case "waiting":
				return LOADING;
		}
	}
	get hydrated(): boolean {
		return this.#status.kind === "live";
	}
	get attachable(): unknown {
		return this.#exposed;
	}
	get swapsInPlace(): boolean {
		return this.#status.kind === "activating" && this.#status.swap !== undefined && !this.#status.swap.parked;
	}
	get instance(): unknown {
		return this.#status.kind === "live" ? this.#exposed : undefined;
	}
	get lastValues(): boolean {
		return this.#exposed !== undefined && this.#status.kind !== "ended";
	}
	get blocksFirstPass(): boolean {
		return !this.#passed;
	}
	get heldOnLink(): false {
		return false;
	}
	get firstOutcome(): Promise<void> {
		if (this.#passed) return Promise.resolve();
		this.#first ??= Promise.withResolvers<void>();
		return this.#first.promise;
	}
	get holders(): ReadonlySet<Holder> {
		return this.#holders;
	}
	get lastFailure(): ObjectsError | undefined {
		return this.#lastFailure;
	}
	get activationId(): string | undefined {
		return this.#status.kind === "activating" ? this.#instance : undefined;
	}
	get variant(): string | undefined {
		return this.#status.kind === "live" ? this.#status.attempt.variant : undefined;
	}
	get stateMembers(): ReadonlyMap<string, DeriveSource> {
		return this.#live().stateMembers;
	}
	activationChain(): string[] | undefined {
		return this.activationId === undefined ? undefined : [...this.chain.slice(-(CHAIN - 1)), this.activationId];
	}
	attempt(): Attempt | undefined {
		const status = this.#status;
		if (status.kind !== "waiting" && status.kind !== "failed") return;
		this.#instance ??= uuidv7();
		const attempt = new Attempt(this, this.#context);
		this.#status = { kind: "activating", attempt, shown: LOADING };
		if (status.kind === "failed") this.#notify();
		void this.#activate(attempt);
		return attempt;
	}
	retry(operation = retryOperation()): void {
		if (operation.visited.has(this)) return;
		operation.visited.add(this);
		const status = this.#status;
		if (status.kind === "activating") {
			if (status.shown.kind === "failed") status.attempt.retryDependencies(operation);
		} else if (status.kind === "waiting" || status.kind === "failed") {
			this.host.backoff.skip(this.identity);
			this.attempt();
		}
	}
	retryOn(sources: readonly RetrySource[]): void {
		if (!this.#wakes && !sources.length) return;
		this.#wakes ??= new RetryWakes();
		this.#wakes.replace(sources, () => this.#wake());
	}
	async call(
		method: string,
		args: unknown,
		context: Context,
		caller: Caller,
		version = this.served.contract.version,
	): Promise<unknown> {
		return this.#live().call(method, args, context, caller, version);
	}
	member(name: string, version = this.served.contract.version): DeriveSource {
		const instance = this.#exposed ?? this.#live();
		return instance.memberAt(name, version);
	}

	keyedMember(name: string): KeyedSlot {
		return this.#live().keyedMember(name);
	}
	keyedMapping(member: string, version: number): ((value: JsonValue) => JsonValue) | undefined {
		return this.#live().keyMapping(member, version);
	}
	async pinKey(
		member: string,
		key: string,
		context: Context,
		version = this.served.contract.version,
	): Promise<PinnedKey> {
		const attempt = this.#live(),
			keyed = attempt.keyedMembers.get(member);
		if (keyed === undefined) throw invalid("member", `${this.label} has no keyed member "${member}"`);
		let raw: PinnedKey;
		if (keyed.kind === "reexposed") raw = await keyed.binding.pinKey(keyed.member, key, context);
		else {
			const slot = keyed.slot,
				release = slot.pin(key, context);
			try {
				await slot.ensure(key, context);
				raw = { source: slot.source(key), release };
			} catch (error) {
				release();
				throw error;
			}
		}
		try {
			const mapped = attempt.mapKey(member, raw.source, version);
			return {
				source: mapped.source,
				release: () => {
					mapped.release();
					raw.release();
				},
			};
		} catch (error) {
			raw.release();
			throw error;
		}
	}

	hold(holder: Holder): void {
		if (this.#status.kind === "live") {
			const error = this.#unfit(holder, this.#status.attempt);
			if (error !== undefined) {
				holder.removed?.({ kind: "waiting", error });
				return;
			}
		}
		this.#holders.add(holder);
		this.#stopLinger();
		this.host.referenced(this, holder, this.#context);
	}
	unhold(holder: Holder): void {
		if (this.#holders.delete(holder)) {
			if (holder.version !== undefined && ![...this.#holders].some((other) => other.version === holder.version))
				this.#exposed?.dropVersion(holder.version);
			if (!this.#unbinding) this.#idle();
			this.host.unreferenced(this, [holder], this.#context);
		}
	}
	jobRecords(definition: JobDefinition<unknown, unknown, unknown>): JobRecords {
		const known = this.#jobs.get(definition.name);
		if (known) {
			known.check(definition);
			known.redefine(definition);
			return known;
		}
		const record = new JobRecords(definition, {
			label: this.label,
			host: this.host,
			context: this.#context,
			documents: this.documents,
			store: this.host.store && { store: this.host.store, owner: this.served.contract.name },
			countRuns: (delta) => this.countRuns(delta),
			held: (deadline) => this.#heldUntil(deadline),
		});
		this.#jobs.set(definition.name, record);
		return record;
	}
	checkJob(definition: JobDefinition<unknown, unknown, unknown>): void {
		this.#jobs.get(definition.name)?.check(definition);
	}
	claimTable(table: string): void {
		this.host.store!.claims.table(table, this);
	}
	claimDocuments(namespace: string): void {
		this.host.store!.claims.documents(this.served.contract.name, namespace, this);
	}
	failLive(attempt: Attempt, cause: FailureCause): void {
		if (this.#status.kind !== "live" || this.#status.attempt !== attempt) return;
		this.#setFailed(cause);
		this.#withdraw(attempt);
		attempt.seal(cause.error);
		const frozen = this.documents.settled().then(() => {
			if (this.#exposed === attempt) this.#exposed = undefined;
			this.host.batch.within(() => this.#notify(), this.#context);
		});
		const closing = Promise.all([attempt.close({ kind: "end" }), frozen]).then(([failures]) => {
			attempt.detach();
			attempt.releaseReferences();
			return failures;
		});
		this.host.ending(this.identity, this.#reportClose(closing));
		this.host.report({ kind: "object_failed", object: this.label, failure: cause });
		this.#notify();
		this.#idle();
	}
	countRuns(delta: number): void {
		this.#runs += delta;
		this.host.count("jobs", delta);
		if (delta > 0) this.#stopLinger();
		if (!this.#runs) this.#idle();
	}
	assertNoCycle(dependency: Target, context: Context): void {
		const visited = new Set<Target>(),
			cycle = dependency.pathTo(this, visited);
		context.telemetry.metrics?.counter("objects.cycle.visits").add(visited.size);
		if (!cycle) {
			const instance = dependency.activationId;
			if (instance !== undefined && this.chain.includes(instance))
				throw this.host.cycle(this.chain, instance, [this.label, dependency.label]);
			return;
		}
		const error = invalid("cycle", `dependency cycle: ${[this, ...cycle].map((object) => object.label).join(" → ")}`);
		for (const object of cycle)
			if (object instanceof ObjectsObject && object !== this && object.#status.kind === "activating")
				object.#status.attempt.abandon({ kind: "failed", cause: { kind: "broken", error } });
		throw error;
	}
	waitsFor(dependencies: readonly Dependency[]): void {
		this.#waiting = dependencies;
	}
	dependencyMoved(): void {
		if (this.#status.kind === "activating") this.#status.attempt.dependencyMoved();
	}
	parked(attempt: Attempt, shown: RefState, firstPass: boolean): void {
		const status = this.#status;
		if (status.kind !== "activating" || status.attempt !== attempt) return;
		const same =
			status.shown === shown ||
			(status.shown.kind === "failed" &&
				shown.kind === "failed" &&
				status.shown.retryAt === shown.retryAt &&
				sameCause(status.shown.cause, shown.cause));
		if (!same) {
			this.#status = { kind: "activating", attempt, shown, ...(status.swap ? { swap: status.swap } : {}) };
			if (shown.kind === "failed") this.#lastFailure = shown.cause.error;
			this.#notify();
		}
		if (status.swap && !status.swap.parked && shown.kind !== "live") {
			status.swap.parked = true;
			this.#withdraw(status.swap.old);
			status.swap.done.resolve();
		}
		if (firstPass) this.#firstOutcome();
	}
	unparked(attempt: Attempt): void {
		this.parked(attempt, LOADING, false);
	}
	reloadFate(recorded: Recorded): "swap" | "restart" | "retry" {
		if (this.#status.kind !== "live") return "retry";
		const migrating = recorded.tables.some((definition) => {
			const table = this.host.store?.table(tableSqlName(this.served.contract.name, definition.name));
			return table !== undefined && table.version < definition.version;
		});
		return this.#status.attempt.opensNatives || recorded.natives > 0 || migrating ? "restart" : "swap";
	}
	reload(served: Served, fate: "swap" | "restart" | "retry"): Attempt {
		this.served = served;
		const state = this.#status;
		if (state.kind === "live") {
			const old = state.attempt;
			if (fate === "swap") {
				old.handOver();
				const swap: Swap = { old, done: Promise.withResolvers<void>(), parked: false };
				const attempt = this.#replace(swap);
				const retiring = (async () => {
					await Promise.all([old.drainCalls(), swap.done.promise]);
					old.seal(this.#reloaded(), "reload");
					await this.documents.settled();
					this.#stopFollowing(old);
					for (const failure of await old.close({ kind: "end" })) this.host.report(failure);
					old.detach();
					old.releaseReferences();
				})();
				this.#retiring.set(old, retiring);
				void retiring.then(() => this.#retiring.delete(old));
				void this.#activate(attempt);
				return attempt;
			}
			this.#withdraw(old);
			old.stopRoutines();
			this.#instance = uuidv7();
			const previous = this.host.endingOf(this.identity);
			const closing = (async () => {
				await Promise.all([old.drainCalls(), ...this.#retiring.values(), previous]);
				old.seal(this.#reloaded(), "reload");
				await this.documents.settled();
				this.#stopFollowing(old);
				const failures = await old.close({ kind: "reload" });
				old.detach();
				old.releaseReferences();
				return failures;
			})();
			this.host.ending(this.identity, this.#reportClose(closing));
			const attempt = this.#replace();
			void this.#activate(attempt);
			return attempt;
		}
		if (state.kind === "activating") {
			state.swap?.done.resolve();
			const old = state.attempt,
				parked = old.isParked,
				previous = this.host.endingOf(this.identity);
			old.seal(this.#reloaded(), "reload");
			const attempt = this.#replace();
			if (parked) void this.#activate(attempt, previous);
			const closing = (async () => {
				if (parked) await attempt.checked;
				const failures = await old.close({ kind: "reload" });
				old.detach();
				old.releaseReferences();
				return failures;
			})();
			this.host.ending(this.identity, this.#reportClose(closing));
			if (!parked) void this.#activate(attempt);
			return attempt;
		}
		this.host.backoff.skip(this.identity);
		const attempt = this.attempt()!;
		attempt.startedByReload();
		return attempt;
	}
	remove(cause: FailureCause): void {
		const closing = this.#seal(this.ended(), cause);
		if (closing.kind !== "none")
			this.host.ending(this.identity, this.#reportClose(this.#teardown(closing, { kind: "end" })));
	}
	#replace(swap?: Swap): Attempt {
		const attempt = new Attempt(this, this.#context);
		attempt.startedByReload();
		this.#status = { kind: "activating", attempt, shown: LOADING, ...(swap ? { swap } : {}) };
		this.#notify();
		return attempt;
	}
	#stopFollowing(attempt: Attempt): void {
		if (this.#exposed !== attempt) return;
		this.#exposed = undefined;
		this.host.batch.within(() => this.#notify(), this.#context);
	}
	#reloaded(): ObjectsError {
		return new ObjectsError({ code: "released", reason: "ended", message: `${this.label}: replaced by a reload` });
	}
	end(error = this.ended()): void {
		const closing = this.#seal(error);
		if (closing.kind !== "none")
			this.host.ending(this.identity, this.#reportClose(this.#teardown(closing, { kind: "end" })));
	}
	stop(): () => Promise<CloseFailed[]> {
		const closing = this.#seal(this.ended());
		return () => this.#teardown(closing, { kind: "close" });
	}
	ended(): ObjectsError {
		return new ObjectsError({ code: "released", reason: "ended", message: `${this.label}: ended` });
	}
	pathTo(target: LocalTarget, visited: Set<Target>): LocalTarget[] | undefined {
		if (this === target) return [this];
		visited.add(this);
		for (const dependency of this.#waiting) {
			const next = dependency.kind === "reference" ? dependency.binding.target : undefined;
			if (!next || visited.has(next)) continue;
			const path = next.pathTo(target, visited);
			if (path) return [this, ...path];
		}
	}
	async #activate(attempt: Attempt, previous = this.host.endingOf(this.identity)): Promise<void> {
		const outcome = await attempt.activate(previous);
		if (this.#status.kind !== "activating" || this.#status.attempt !== attempt) return;
		if (outcome.kind === "live") this.#wentLive(attempt);
		else if (outcome.kind === "failed") this.#activationFailed(attempt, outcome.cause);
	}
	#wentLive(attempt: Attempt): void {
		const swap = this.#status.kind === "activating" ? this.#status.swap : undefined;
		let unfit = false;
		this.#unbinding = true;
		for (const holder of [...this.#holders]) {
			const error = this.#unfit(holder, attempt);
			if (error !== undefined) {
				unfit = true;
				holder.removed?.({ kind: "waiting", error });
			}
		}
		this.#unbinding = false;
		if (this.#wakes) this.#wakes.during = undefined;
		this.#status = { kind: "live", attempt };
		this.#exposed = attempt;

		if (attempt.contributions.length || (swap && !swap.parked))
			this.host.batch.within(() => {
				if (swap && !swap.parked)
					for (const contribution of swap.old.contributions) contribution.record.remove(contribution);
				for (const contribution of attempt.contributions) contribution.record.add(contribution);
			}, this.#context);
		this.#lastFailure = undefined;
		this.host.wentLive(this);
		this.#notify();
		this.#firstOutcome();
		swap?.done.resolve();
		attempt.live(swap?.old.drainRoutines());
		for (const [name, records] of this.#jobs) {
			if (!attempt.declaresJob(name)) records.undeclare();
			else if (attempt.reloadStarted) void records.retryBlocked(this.#context);
		}
		if (unfit) this.#idle();
	}
	#unfit(holder: Holder, attempt: Attempt): ObjectsError | undefined {
		const version = holder.version;
		if (version === undefined) return;
		if (!binds(this.served.provider, version, holder.fingerprint ?? this.served.contract.fingerprint))
			return new ObjectsError({
				code: "contract_mismatch",
				message: `${this.served.contract.name} v${version} is not served here`,
			});
		if (version !== this.served.contract.version) return refusal(this.served, version, attempt.variant);
	}
	#activationFailed(attempt: Attempt, cause: FailureCause): void {
		const swap = this.#status.kind === "activating" ? this.#status.swap : undefined;
		if (swap) {
			this.#withdraw(swap.old);
			swap.done.resolve();
		}
		const woken = this.#wakes?.during === attempt;
		if (this.#wakes) this.#wakes.during = undefined;
		this.#setFailed(cause);
		attempt.seal(this.ended());
		const closing = attempt.close({ kind: "end" }).then((failures) => {
			attempt.detach();
			attempt.releaseReferences();
			return failures;
		});
		this.host.ending(this.identity, this.#reportClose(closing));
		this.host.report({ kind: "activation_failed", object: this.label, failure: cause });
		this.#notify();
		this.#firstOutcome();
		this.#idle();
		if (woken) this.retry();
	}
	#setFailed(cause: FailureCause): void {
		if (cause.kind === "transient") this.host.backoff.failed(this.identity);
		else this.host.backoff.delete(this.identity);
		this.#status = {
			kind: "failed",
			failure: { kind: "failed", cause, retryAt: this.host.backoff.until(this.identity) },
		};
		this.#lastFailure = cause.error;
	}
	#wake(): void {
		if (this.#status.kind === "activating") {
			if (!this.#status.attempt.isParked) this.#wakes!.during = this.#status.attempt;
		} else if (this.#status.kind === "failed" && !this.#wakes!.leaving) queueMicrotask(() => this.retry());
	}
	#withdraw(attempt: Attempt): void {
		if (!attempt.contributions.length) return;
		this.host.batch.within(() => {
			const wakes = this.#wakes;
			if (wakes) {
				wakes.leaving = true;
				this.host.batch.flushing(() => {
					wakes.leaving = false;
				});
			}
			for (const contribution of attempt.contributions) contribution.record.remove(contribution);
		}, this.#context);
	}

	#notify(): void {
		const holders = [...this.#holders];
		const retarget = (): void => {
			for (const holder of holders) holder.retarget?.();
		};
		if (holders.some(holder => holder.following)) this.host.batch.within(retarget, this.#context);
		else retarget();
		for (const holder of holders) holder.moved();
	}
	#firstOutcome(): void {
		if (!this.#passed) {
			this.#passed = true;
			this.#first?.resolve();
			this.#first = undefined;
			for (const holder of this.#holders) holder.dependent?.dependencyMoved();
		}
	}
	#seal(error: ObjectsError, removal?: FailureCause): Teardown {
		const status = this.#status;
		if (status.kind === "ended") return { kind: "none" };
		const pending = [...this.#retiring.values()],
			ending = this.host.endingOf(this.identity);
		if (ending) pending.push(ending);
		const previous = pending.length ? Promise.all(pending).then(() => {}) : undefined;
		if (removal) for (const holder of this.#holders) holder.freeze?.();
		this.#status = { kind: "ended", state: { kind: "ended", error } };
		for (const records of this.#jobs.values()) records.end(error);
		clearTimeout(this.#flush?.timer);
		this.#flush = undefined;
		this.documents.seal();
		this.#stopLinger();
		this.#wakes?.stop();
		this.host.forget(this);
		this.#firstOutcome();
		this.#exposed = undefined;
		const holders = [...this.#holders];
		this.#holders.clear();
		this.host.unreferenced(this, holders, this.#context);
		for (const holder of holders) {
			if (removal && holder.removed) holder.removed(removal);
			else holder.end(error);
		}
		for (const old of this.#retiring.keys()) old.seal(error);
		if (status.kind === "activating") status.swap?.done.resolve();
		if (status.kind === "waiting" || status.kind === "failed") return { kind: "end", previous };
		if (status.kind === "live") this.#withdraw(status.attempt);
		status.attempt.seal(error);
		return { kind: "close", previous, attempt: status.attempt };
	}
	#idle(): void {
		const phase = this.#status.kind,
			running = this.#runs > 0 && (phase === "live" || phase === "activating");
		if (
			this.#holders.size ||
			running ||
			(this.served.kind === "local" && this.served.hostLifetime) ||
			phase === "ended" ||
			this.#linger !== undefined
		)
			return;
		if (phase !== "live" || !this.served.linger) {
			this.end();
			return;
		}
		this.#linger = setTimeout(() => {
			this.#stopLinger();
			this.end();
		}, this.served.linger);
		this.host.count("lingering", 1);
	}
	#stopLinger(): void {
		if (this.#linger !== undefined) {
			clearTimeout(this.#linger);
			this.#linger = undefined;
			this.host.count("lingering", -1);
		}
	}
	async #teardown(closing: Teardown, reason: NativeCloseReason): Promise<CloseFailed[]> {
		if (closing.kind === "none") return [];
		await closing.previous;
		const failures = closing.kind === "close" ? await closing.attempt.close(reason) : [];
		if (closing.kind === "close") {
			closing.attempt.detach();
			closing.attempt.releaseReferences();
		}
		await this.documents.settled();
		this.documents.end();
		this.host.store?.claims.release(this);
		for (const records of this.#jobs.values()) records.drop();
		this.#jobs.clear();
		return failures;
	}
	async #reportClose(closing: Promise<CloseFailed[]>): Promise<void> {
		for (const failure of await closing) this.host.report(failure);
	}
	#live(): Attempt {
		if (this.#status.kind === "live") return this.#status.attempt;
		if (this.#status.kind === "ended") throw this.ended();
		if (this.#status.kind === "failed") throw this.#status.failure.cause.error;
		throw new ObjectsError({ code: "not_ready", message: `${this.label}: not live yet` });
	}
	#heldUntil(deadline: number): void {
		if (this.#flush && this.#flush.deadline <= deadline) return;
		clearTimeout(this.#flush?.timer);
		this.#flush = {
			deadline,
			timer: setTimeout(
				() => {
					void this.#flushHeld();
				},
				Math.max(0, deadline - Date.now()),
			),
		};
	}
	async #flushHeld(): Promise<void> {
		this.#flush = undefined;
		if (this.#status.kind === "ended") return;
		const now = Date.now(),
			jobs = [...this.#jobs.values()];
		await Promise.all(jobs.map((job) => job.flushHeld(now)));
		const next = Math.min(...jobs.map((job) => job.nextDeadline()));
		if (Number.isFinite(next)) this.#heldUntil(next);
	}
}
