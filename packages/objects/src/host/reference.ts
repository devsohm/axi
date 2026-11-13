import { RETRY_HOPS } from "../link/internal.ts";
import { BACKGROUND_CONTEXT, type Context } from "../context/index.ts";
import type { JsonValue } from "../json.ts";
import type { NativeWatchable, Watch, Watchable } from "../watch.ts";
import type { Contract, EventSubscription, Implementation, KindShape, ParamsOf } from "../contracts/index.ts";
import {
	currentVariants,
	keyOfAddress,
	LOCAL,
	takesNoArgs,
	type CurrentVariants,
	type MethodData,
	type ShapeOf,
	type VariantImplementation,
} from "../contracts/internal.ts";
import { ObjectsError, type FailureCause, type Principal } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import { storedText } from "../store/text.ts";
import { Keyed, Singleton, type KeyedSlot } from "../documents/internal.ts";
import { Constant, Source, type Batch, type DeriveSource } from "../state/internal.ts";
import { withLinkedAbortSignal, type Caller } from "./ctx.ts";
import { ParkedCalls } from "./parked.ts";
import { MemberSource } from "./member-source.ts";
import { HeldKeys } from "./held-keys.ts";
import { LOADING, ReferenceState, type Ended, type Failed, type RefState } from "./ref-state.ts";
import { subscribe, type EventListener, type EventNode, type HostEvents } from "./events.ts";
import { ReferenceEvents, ReferenceEventTaps } from "./reference-events.ts";

type Lifecycle = {
	readonly state: NativeWatchable<RefState>;
	retry(): void;
	release(): void;
};
type Variants<C extends Contract, Unbound> = {
	[V in keyof CurrentVariants<C>]: {
		readonly variant: V | Unbound;
	} & VariantImplementation<CurrentVariants<C>[V]> &
		Lifecycle;
}[keyof CurrentVariants<C>];
export type Reference<C extends Contract> = ShapeOf<C>["kind"] extends "local"
	? Implementation<C> & Lifecycle
	: Variants<C, never>;
export type Held<C extends Contract> = ShapeOf<C>["kind"] extends "local"
	? Implementation<C> & Lifecycle
	: Variants<C, undefined>;
export type RefIn<C extends Contract, V extends string> = Extract<Reference<C>, { readonly variant: V }>;
export type RetryOperation = {
	readonly visited: Set<Target>;
	readonly hops: number;
};
export function retryOperation(hops = RETRY_HOPS): RetryOperation {
	return { visited: new Set(), hops };
}
export type CheckedParams = {
	readonly params: ParamsOf<Contract>;
	readonly key: string;
};
export type PinnedKey = {
	readonly source: DeriveSource;
	readonly release: () => void;
};
export type KeyedBinding =
	| { readonly kind: "own"; readonly slot: KeyedSlot }
	| {
			readonly kind: "reexposed";
			readonly binding: Binding;
			readonly member: string;
			readonly key: string | undefined;
	  };
export interface Target {
	readonly kind: "local" | "remote";
	readonly instance?: unknown;
	readonly attachable?: Attachable;
	readonly label: string;
	readonly state: RefState;
	readonly hydrated: boolean;
	readonly variant: string | undefined;
	readonly lastFailure: ObjectsError | undefined;
	readonly activationId: string | undefined;
	readonly heldOnLink: boolean;
	readonly blocksFirstPass: boolean;
	readonly lastValues: boolean;
	stateFor(version: number, fingerprint: string): RefState;
	waitFor?<T>(waiting: Promise<T>, context: Context): Promise<T>;
	hold(binding: Binding): void;
	unhold(binding: Binding): void;
	call(method: string, args: unknown, binding: Binding, context: Context): Promise<unknown>;
	generationOf?(member: string): number | undefined;
	member(member: string, version?: number): DeriveSource;
	keyedMapping?(member: string, version: number): ((value: JsonValue) => JsonValue) | undefined;
	keyedMember(member: string): KeyedSlot;
	pinKey(member: string, key: string, context: Context, version?: number): Promise<PinnedKey>;
	retry(operation: RetryOperation, binding: Binding): void;
	pathTo(target: LocalTarget, visited: Set<Target>): LocalTarget[] | undefined;
}
export type Attachable = {
	readonly variant: string | undefined;
	eventNode(member: string, version: number): EventNode | undefined;
};
type EventsAt = { readonly instance: Attachable; readonly boundAt: number };
export interface LocalTarget extends Target {
	dependencyMoved(): void;
}
type Status =
	| { readonly kind: "unbound" }
	| { readonly kind: "bound"; readonly target: Target }
	| {
			readonly kind: "waiting";
			readonly failure: Failed | undefined;
			readonly place: () => void;
			readonly leave: () => void;
	  }
	| {
			readonly kind: "refused";
			readonly failure: Failed;
			readonly place: () => void;
	  }
	| { readonly kind: "released"; readonly state: Ended };
type Waiter = { check(): void; end(error: ObjectsError): void };
type Decision = { readonly kind: "wait" | "done" } | { readonly kind: "failed"; readonly error: unknown };
const wait: Decision = { kind: "wait" },
	done: Decision = { kind: "done" };

export class Binding {
	readonly fingerprint: string;
	#place: ((cause: FailureCause) => void) | undefined;
	readonly version: number;
	readonly reference: Reference<Contract>;
	readonly caller: Caller;
	readonly #name: string;
	readonly #timeout: number;
	#owner: { readonly batch: Batch; readonly dependent: LocalTarget | undefined } | undefined;
	#status: Status = { kind: "unbound" };
	#stateSource: ReferenceState | undefined;
	#calls: AbortController | undefined;
	#parked: ParkedCalls | undefined;
	readonly #waiters = new Set<Waiter>();
	readonly #watches = new Set<Watch<JsonValue>>();
	readonly #pins: KeyedMemberAt[] = [];
	readonly #remoteMembers = new Map<string, MemberSource>();
	#unseen: Map<string, number> | undefined;
	readonly #variants: ReturnType<typeof currentVariants>;
	#attached = false;
	#variant: string = LOCAL;
	#heldKeys: HeldKeys | undefined;
	#events: { readonly host: HostEvents; at: EventsAt | undefined; taps: ReferenceEventTaps | undefined } | undefined;
	#listed = true;
	get listed(): boolean {
		return this.#listed;
	}
	unlist(): void {
		this.#listed = false;
	}
	constructor(
		contract: Contract,
		batch: Batch,
		dependent: LocalTarget | undefined,
		caller: Caller,
		parkTimeout: number,
		events: HostEvents,
	) {
		this.#name = contract.name;
		this.version = contract.version;
		this.fingerprint = contract.fingerprint;
		this.#owner = { batch, dependent };
		this.caller = caller;
		this.#timeout = parkTimeout;
		this.#variants = currentVariants(contract);
		const members: Record<string, unknown> = {
			release: () => this.release(),
			retry: () => this.retry(),
		};
		Object.defineProperty(members, "state", {
			enumerable: true,
			get: () => this.#observableState(),
		});
		const methods = new Map<string, MethodData>();
		for (const variant of currentVariants(contract).values()) {
			if (variant.events.size) {
				this.#events ??= { host: events, at: undefined, taps: undefined };
				for (const name of variant.events.keys()) members[name] = new ReferenceEvents(this, name);
			}
			for (const name of variant.state.keys()) members[name] = new ReferenceMember(this, name);
			for (const [name, { key }] of variant.keyed) members[name] = new ReferenceKeyed(this, name, key);
			for (const [name, method] of variant.methods) methods.set(name, method);
		}
		for (const [name, method] of methods)
			members[name] = takesNoArgs(method)
				? async (context: Context) => this.#call(name, null, context)
				: async (args: unknown, context: Context) => this.#call(name, args, context);
		if (contract.kind === "remote")
			Object.defineProperty(members, "variant", {
				enumerable: true,
				get: () => {
					if (this.#status.kind === "released") throw this.#status.state.error;
					return this.target?.variant;
				},
			});
		this.reference = members as Reference<Contract>;
	}
	get dependent(): LocalTarget | undefined {
		return this.#owner?.dependent;
	}
	get principal(): Principal | undefined {
		return this.caller.principal;
	}
	get target(): Target | undefined {
		return this.#status.kind === "bound" ? this.#status.target : undefined;
	}
	get label(): string {
		return this.target?.label ?? this.#name;
	}
	get refState(): RefState {
		switch (this.#status.kind) {
			case "bound":
				return this.#status.target.stateFor(this.version, this.fingerprint);
			case "unbound":
				return LOADING;
			case "waiting":
				return this.#status.failure ?? LOADING;
			case "refused":
				return this.#status.failure;
			case "released":
				return this.#status.state;
		}
	}
	get lastFailure(): ObjectsError | undefined {
		const status = this.#status;
		return status.kind === "bound"
			? status.target.lastFailure
			: status.kind === "waiting" || status.kind === "refused"
				? status.failure?.cause.error
				: undefined;
	}
	bind(target: Target): void {
		if (this.#status.kind === "unbound") {
			this.#boundTo(target);
		}
	}
	transfer(target: Target): void {
		if (this.#status.kind === "bound") this.#boundTo(target);
	}
	#boundTo(target: Target): void {
		this.#status = { kind: "bound", target };
		target.hold(this);
		this.retarget();
		this.moved();
	}
	joined(members: ReadonlyMap<string, number>): void {
		for (const [member, generation] of members) {
			if (this.#remoteMembers.has(member)) continue;
			(this.#unseen ??= new Map()).set(member, generation);
		}
	}
	#seen(member: string): boolean {
		const before = this.#unseen?.get(member);
		if (before === undefined) return true;
		const now = this.target?.generationOf?.(member);
		if (now === undefined || now <= before) return false;
		this.#unseen!.delete(member);
		return true;
	}
	whenUnbound(place: (cause: FailureCause) => void): void {
		this.#place = place;
	}
	removed(cause: FailureCause): void {
		const target = this.target;
		this.freeze();
		this.#status = { kind: "unbound" };
		if (this.#events) {
			this.#events.at = undefined;
			this.#events.taps?.retarget(undefined);
		}
		target?.unhold(this);
		if (this.#place) this.#place(cause);
		else this.refuse(cause, () => {});
	}
	#takeMembers(): void {
		const target = this.target;
		if (!this.#attached || !target?.lastValues) return;
		for (const name of this.#variants.get(this.#variant)?.state.keys() ?? [])
			if (!this.#remoteMembers.has(name))
				this.#remoteMembers.set(name, new MemberSource(target.member(name, this.version), this.#owner!.batch));
	}
	freeze(): void {
		this.#takeMembers();
		for (const source of this.#remoteMembers.values()) source.freeze();
		this.#heldKeys?.freeze();
	}
	wait(cause: FailureCause | undefined, place: () => void, leave: () => void): void {
		if (this.#status.kind !== "unbound") return;
		const failure: Failed | undefined = cause && {
			kind: "failed",
			cause,
			retryAt: undefined,
		};
		this.#status = { kind: "waiting", failure, place, leave };
		if (failure) {
			this.retarget();
			this.moved();
		}
	}
	wake(): void {
		const status = this.#status;
		if (status.kind === "waiting") {
			this.#status = { kind: "unbound" };
			status.place();
		}
	}
	refuse(cause: FailureCause, place: () => void): void {
		if (this.#status.kind !== "unbound") return;
		this.#status = {
			kind: "refused",
			failure: { kind: "failed", cause, retryAt: undefined },
			place,
		};
		this.retarget();
		this.moved();
	}
	get following(): boolean {
		return this.#remoteMembers.size > 0 || this.#heldKeys !== undefined;
	}
	retarget(): void {
		if (this.#status.kind === "released") return;
		const state = this.refState;
		if (this.#events) {
			const instance = state.kind === "live" ? this.target?.attachable : undefined;
			if (instance !== this.#events.at?.instance) {
				this.#events.at = instance ? { instance, boundAt: this.#events.host.counter } : undefined;
				this.#events.taps?.retarget(this.#events.at);
			}
		}
		if (state.kind === "loading") {
			this.#takeMembers();
			if (!this.target?.lastValues) for (const source of this.#remoteMembers.values()) source.freeze();
		} else if (state.kind === "live") {
			const target = this.#requireTarget();
			this.#attached = true;
			this.#variant = target.variant ?? LOCAL;
			this.#owner!.batch.within(() => {
				for (const [name, source] of this.#remoteMembers) {
					try {
						source.bind(target.member(name, this.version));
					} catch (error) {
						if (error instanceof ObjectsError && error.code === "invalid" && error.reason === "member")
							source.vanish(error, BACKGROUND_CONTEXT);
						else throw error;
					}
				}
			}, BACKGROUND_CONTEXT);
		} else if (state.kind === "failed" && this.#attached) {
			const target = this.target;
			if (target?.lastValues) {
				for (const name of this.#variants.get(this.#variant)?.state.keys() ?? []) this.member(name);
			} else
				this.#owner!.batch.within(() => {
					for (const source of this.#remoteMembers.values()) source.fail(state.cause.error, BACKGROUND_CONTEXT);
				}, BACKGROUND_CONTEXT);
		}
		if (this.#heldKeys)
			this.#owner!.batch.within(() => {
				if (state.kind === "failed" && this.target === undefined)
					this.#heldKeys?.fail(state.cause.error, BACKGROUND_CONTEXT);
				else this.#heldKeys?.follow(BACKGROUND_CONTEXT);
			}, BACKGROUND_CONTEXT);
	}
	moved(): void {
		const state = this.refState;
		this.#stateSource?.moved();
		if (state.kind === "live")
			this.#parked?.flush(
				(method, args, context) => this.#send(method, args, context),
				() => this.refState.kind === "live",
			);
		else if (state.kind === "failed") this.#parked?.reject(state.cause.error);
		for (const waiter of [...this.#waiters]) waiter.check();
		this.dependent?.dependencyMoved();
	}
	live(context: Context): Promise<void> {
		return this.#until(
			(state) =>
				state.kind === "live"
					? done
					: state.kind === "failed" && state.cause.kind === "broken"
						? { kind: "failed", error: state.cause.error }
						: wait,
			context,
		);
	}
	until(predicate: () => boolean, context: Context): Promise<void> {
		return this.#until(() => (predicate() ? done : wait), context);
	}
	member(name: string): DeriveSource {
		if (this.#status.kind === "released") throw this.#status.state.error;
		let source = this.#remoteMembers.get(name);
		if (source === undefined) {
			const state = this.refState;
			const attached = this.target;
			const target =
				attached !== undefined &&
				(state.kind === "live" ||
					(this.#attached && (attached.lastValues || (attached.kind === "remote" && attached.hydrated))))
					? attached
					: this.#requireTarget();
			source = new MemberSource(target.member(name, this.version), this.#owner!.batch);
			if (this.#unseen?.has(name)) source.unseen(() => this.#seen(name));
			if (state.kind !== "live" && target.kind === "remote") {
				source.freeze();
				if (state.kind === "failed") source.fail(state.cause.error, BACKGROUND_CONTEXT);
			}
			this.#remoteMembers.set(name, source);
		}
		return source;
	}
	subscribeEvents(member: string, listener: EventListener, context: Context): Promise<EventSubscription> {
		if (this.#status.kind === "released") return Promise.reject(this.#status.state.error);
		const taps = this.#eventTaps();
		return subscribe(
			this.#events!.host,
			listener,
			context,
			(subscription) => taps.subscribe(member, subscription),
			(subscription) => this.#events?.taps?.unsubscribe(member, subscription),
		);
	}
	forwardEvents(member: string, node: EventNode): void {
		if (this.#status.kind !== "released") this.#eventTaps().forward(member, node);
	}
	unforwardEvents(member: string, node: EventNode): void {
		this.#events?.taps?.unforward(member, node);
	}
	#eventTaps(): ReferenceEventTaps {
		const events = this.#events!;
		return (events.taps ??= new ReferenceEventTaps(this.version, events.at));
	}
	keyedMapping(name: string): ((value: JsonValue) => JsonValue) | undefined {
		return this.#requireTarget().keyedMapping?.(name, this.version);
	}
	keyedSlot(name: string): KeyedSlot {
		return this.#requireTarget().keyedMember(name);
	}
	pinKey(name: string, key: string, context: Context): Promise<PinnedKey> {
		try {
			this.#requireTarget();
			this.#heldKeys ??= new HeldKeys({
				batch: this.#owner!.batch,
				version: this.version,
				target: () => this.target,
				unavailable: () =>
					this.#status.kind === "released"
						? this.#status.state.error
						: (this.lastFailure ?? new ObjectsError({ code: "not_ready", message: `${this.#name}: not live yet` })),
			});
			return this.#heldKeys.pin(name, key, context);
		} catch (error) {
			return Promise.reject(error);
		}
	}
	async hydrated(context: Context): Promise<void> {
		if (this.target?.hydrated && this.refState.kind === "live") return;
		await this.#until(
			(state) =>
				state.kind === "live" ? done : state.kind === "failed" ? { kind: "failed", error: state.cause.error } : wait,
			context,
		);
	}
	async firstValues(context: Context): Promise<void> {
		if (this.target?.hydrated && this.refState.kind === "live") return;
		await this.#until((state) => (state.kind === "live" ? done : wait), context);
	}
	async watch(name: string, context: Context): Promise<Watch<JsonValue>> {
		this.#owner?.batch.assertOutside("watch");
		if (!this.#attached) await this.firstValues(context);
		return this.follow(this.member(name).openWatch(context));
	}
	follow<W extends Watch<JsonValue>>(watch: W): W {
		if (this.#status.kind === "released") {
			watch.end({ kind: "ended" });
			throw this.#status.state.error;
		}
		this.#watches.add(watch);
		void watch.closed.then(() => this.#watches.delete(watch));
		return watch;
	}
	at(member: string, key: string): KeyedMemberAt {
		if (this.#status.kind !== "unbound" || !this.dependent)
			throw new Error(`${this.#name}: ${member}.at(key) is valid only in the factory`);
		const pin = new KeyedMemberAt(this, member, key);
		this.#pins.push(pin);
		return pin;
	}
	get pinsKeys(): boolean {
		return this.#pins.length > 0;
	}
	pinKeys(context: Context): Promise<void> | undefined {
		if (this.#pins.length)
			return (async () => {
				for (const pin of this.#pins) await pin.pin(this, context);
			})();
	}
	retry(operation = retryOperation()): void {
		const status = this.#status;
		if (status.kind === "bound") status.target.retry(operation, this);
		else if (status.kind === "refused") {
			this.#status = { kind: "unbound" };
			this.moved();
			status.place();
		}
	}
	release(): void {
		if (this.#status.kind === "released") return;
		this.#owner!.batch.assertOutside("release");
		this.target?.unhold(this);
		this.end(
			new ObjectsError({
				code: "released",
				message: `${this.#name}: released`,
			}),
		);
	}
	end(error: ObjectsError): void {
		void error.stack;
		const previous = this.#status,
			owner = this.#owner,
			ended: Ended = { kind: "ended", error };
		this.#status = { kind: "released", state: ended };
		this.#owner = undefined;
		const eventTaps = this.#events?.taps;
		this.#events = undefined;
		eventTaps?.end();
		this.#place = undefined;
		const keys = this.#heldKeys,
			sources = [...this.#remoteMembers.values()];
		this.#heldKeys = undefined;
		this.#remoteMembers.clear();
		this.#unseen = undefined;
		if (keys || sources.length) {
			const detach = () => {
				keys?.end(error);
				for (const source of sources) source.objectEnded(error);
			};
			// Ending a source invalidates derives; publish their failures in the same batch.
			if (owner && (keys || sources.some((source) => source.watched || source.dependents.size)))
				owner.batch.within(detach, BACKGROUND_CONTEXT);
			else detach();
		}
		if (previous.kind === "waiting") previous.leave();
		for (const pin of this.#pins) pin.release();
		this.#calls?.abort(error);
		this.#calls = undefined;
		this.#parked?.reject(error);
		this.#parked = undefined;
		for (const watch of this.#watches) watch.end({ kind: "ended" });
		this.#stateSource?.released(ended);
		for (const waiter of this.#waiters) waiter.end(error);
		if (previous.kind !== "released") owner?.dependent?.dependencyMoved();
	}
	#requireTarget(): Target {
		const status = this.#status,
			state = this.refState;
		if (state.kind === "ended") throw state.error;
		if (state.kind === "failed") throw state.cause.error;
		if (status.kind === "bound") return status.target;
		throw new ObjectsError({
			code: "not_ready",
			message: `${this.#name}: not live yet`,
		});
	}
	#call(method: string, args: unknown, context: Context): Promise<unknown> {
		const state = this.refState;
		if (state.kind === "ended") throw state.error;
		if (state.kind === "failed") throw state.cause.error;
		if (state.kind === "live" && !this.#parked?.waiting) return this.#send(method, args, context);
		this.#parked ??= new ParkedCalls(this.#timeout, this.label);
		const parked = this.#parked.park(method, args, context);
		return this.target?.waitFor?.(parked, context) ?? parked;
	}
	#send(method: string, args: unknown, context: Context): Promise<unknown> {
		const target = this.#requireTarget();
		this.#calls ??= new AbortController();
		const linked = withLinkedAbortSignal(this.#calls.signal, context);
		return target.call(method, args, this, linked.context).finally(linked.release);
	}
	#until(decide: (state: RefState) => Decision, context: Context): Promise<void> {
		if (this.#status.kind === "released") return Promise.reject(this.#status.state.error);
		return new Promise<void>((resolve, reject) => {
			const signal = context.abortSignal;
			const settle = (action: () => void): void => {
				this.#waiters.delete(waiter);
				signal?.removeEventListener("abort", abort);
				action();
			};
			const abort = (): void => settle(() => reject(signal?.reason));
			const waiter: Waiter = {
				check: () => {
					const decision = decide(this.refState);
					if (decision.kind === "done") settle(resolve);
					else if (decision.kind === "failed") settle(() => reject(decision.error));
				},
				end: (error) => settle(() => reject(error)),
			};
			this.#waiters.add(waiter);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			else waiter.check();
		});
	}
	#observableState(): ReferenceState {
		if (!this.#stateSource) {
			this.#stateSource = new ReferenceState(() => this.refState, this.#owner?.batch);
			if (this.#status.kind === "released") this.#stateSource.released(this.#status.state);
		}
		return this.#stateSource;
	}
}

class ReferenceMember {
	readonly #binding: Binding;
	readonly #name: string;
	constructor(binding: Binding, name: string) {
		this.#binding = binding;
		this.#name = name;
	}
	get source(): DeriveSource {
		return this.#binding.member(this.#name);
	}
	get value(): JsonValue {
		return this.source.value;
	}
	watch(context: Context): Promise<Watch<JsonValue>> {
		return this.#binding.watch(this.#name, context);
	}
}
class ReferenceKeyed {
	readonly #binding: Binding;
	readonly #name: string;
	readonly kind: KindShape | undefined;
	constructor(binding: Binding, name: string, kind: KindShape | undefined) {
		this.#binding = binding;
		this.#name = name;
		this.kind = kind;
	}
	#key(value: unknown): string {
		if (this.kind === undefined) return value as string;
		const key = keyOfAddress(this.kind, value);
		if (key === undefined) throw invalid("args", `${this.#name}: expected an address of ${this.kind.kind}`);
		return storedText(key, `${this.#name}: key`);
	}
	get slot(): KeyedSlot {
		return this.#binding.keyedSlot(this.#name);
	}
	get keyed(): KeyedBinding {
		return { kind: "reexposed", binding: this.#binding, member: this.#name, key: this.kind?.kind };
	}
	async get(raw: unknown, context: Context): Promise<JsonValue | undefined> {
		const key = this.#key(raw);
		await this.#binding.hydrated(context);
		const slot = this.slot;
		const mapping = this.#binding.keyedMapping(this.#name);
		const value = await slot.get(key, { token: slot.owner.own, version: slot.definition.current.version }, context);
		return value === undefined || mapping === undefined ? value : mapping(value);
	}
	async watch(raw: unknown, context: Context): Promise<Watch<JsonValue> | undefined> {
		const key = this.#key(raw);
		await this.#binding.firstValues(context);
		const slot = this.slot;
		if (
			(await slot.get(key, { token: slot.owner.own, version: slot.definition.current.version }, context)) === undefined
		)
			return undefined;
		const pin = await this.#binding.pinKey(this.#name, key, context);
		if (!slot.current(slot.key(key))) {
			pin.release();
			return undefined;
		}
		let watch: Watch<JsonValue>;
		try {
			watch = pin.source.openWatch(context);
		} catch (error) {
			pin.release();
			throw error;
		}
		void watch.closed.then(pin.release);
		return this.#binding.follow(watch);
	}
	at(key: unknown): Watchable<JsonValue> {
		return this.#binding.at(this.#name, this.#key(key));
	}
}
class KeyedMemberAt {
	readonly #binding: Binding;
	readonly member: string;
	readonly key: string;
	#status:
		| { readonly kind: "new" }
		| { readonly kind: "held"; readonly pin: PinnedKey }
		| { readonly kind: "released" } = { kind: "new" };
	constructor(binding: Binding, member: string, key: string) {
		this.#binding = binding;
		this.member = member;
		this.key = key;
	}
	get source(): DeriveSource {
		if (this.#status.kind === "held") return this.#status.pin.source;
		throw new ObjectsError({
			code: this.#status.kind === "released" ? "released" : "not_ready",
			message: `${this.member}.at(${this.key}): ${this.#status.kind === "released" ? "released" : "not loaded yet"}`,
		});
	}
	get value(): JsonValue {
		return this.source.value;
	}
	async watch(context: Context): Promise<Watch<JsonValue>> {
		return this.#binding.follow(this.source.openWatch(context));
	}
	async pin(binding: Binding, context: Context): Promise<void> {
		if (this.#status.kind === "new") this.#accept(await binding.pinKey(this.member, this.key, context));
	}
	#accept(pin: PinnedKey): void {
		if (this.#status.kind === "new") this.#status = { kind: "held", pin };
		else pin.release();
	}
	release(): void {
		const status = this.#status;
		this.#status = { kind: "released" };
		if (status.kind === "held") status.pin.release();
	}
}
export function resolveKeyed(value: unknown): KeyedBinding | undefined {
	return value instanceof Keyed
		? { kind: "own", slot: value.slot }
		: value instanceof ReferenceKeyed
			? value.keyed
			: undefined;
}
export function resolveWatchable(value: unknown): DeriveSource | undefined {
	if (value instanceof Singleton) return value.slot;
	if (value instanceof ReferenceMember || value instanceof KeyedMemberAt) return value.source;
	return value instanceof Source || value instanceof Constant ? value : undefined;
}
