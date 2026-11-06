import type { TelemetryContext } from "@axi/telemetry";
import { objectsMetrics } from "../telemetry.ts";
import type { Context } from "../context/index.ts";
import { type Encoder, encoder, type Op, PendingOps } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import { variantsAt, type VariantData, type VariantNames, variantNames, variantOrder } from "../contracts/internal.ts";
import { ObjectsError, type FailureCause, isObjectsError, type Principal } from "../data/index.ts";
import { asObjectsError } from "../data/internal.ts";
import type { Caller } from "../host/ctx.ts";
import type { Serving } from "../host/host.ts";
import type { ObjectsObject, Holder } from "../host/object.ts";
import { retryOperation } from "../host/reference.ts";
import type { UnboundRequest } from "../host/unbound.ts";
import {
	type BoundEntry,
	type FailedMember,
	jsonPart,
	type Limits,
	type Message,
	NO_RETIRED,
	oversized,
	parsePart,
	type StateEntry,
	wireError,
} from "../link/internal.ts";
import { Source, type Subscriber } from "../state/internal.ts";
import type { HostLink } from "./host-link.ts";
import type { ProviderSide } from "./provider.ts";
import { RelayedHold } from "./relay.ts";
type HoldMessage = Extract<Message, { kind: "hold" }>;
export type HoldRequest = Omit<HoldMessage, "kind" | "origin" | "hold" | "principal" | "incarnation">;
type Subscription = {
	readonly index: number;
	readonly source: Source;
	readonly subscriber: Subscriber;
	readonly encoder: Encoder;
	readonly pending: PendingOps;
};
type Bound = {
	readonly kind: "bound";
	readonly instance: unknown;
	readonly variant: VariantData;
	readonly names: VariantNames;
	readonly followed: Subscription[];
	readonly previous?: BoundNames & { readonly until: number };
};
type BoundNames = Pick<Bound, "variant" | "names">;
type State =
	| { readonly kind: "unplaced"; readonly request: HoldRequest }
	| { readonly kind: "pending"; readonly told?: ObjectsError; readonly previous?: BoundNames }
	| { readonly kind: "binding"; readonly previous?: BoundNames }
	| Bound
	| { readonly kind: "refused"; readonly request: HoldRequest; readonly cause: FailureCause }
	| { readonly kind: "released" };
const pending: State = { kind: "pending" };
export class Hold implements Holder, UnboundRequest {
	readonly kind = "served";
	readonly listed = true;
	readonly id: number;
	readonly dependent = undefined;
	readonly caller: Caller;
	readonly limits: Limits;
	readonly #side: ProviderSide;
	#status: State = pending;
	#object: ObjectsObject | undefined;
	#request: HoldRequest | undefined;
	#updates: (readonly [Subscription, readonly Op[]])[] = [];
	#failures: FailedMember[] = [];
	#retirements: readonly number[] = NO_RETIRED;
	#dirty = false;
	#counted = true;
	constructor(id: number, provider: ProviderSide, caller: Caller, limits: Limits) {
		this.id = id;
		this.#side = provider;
		this.caller = caller;
		this.limits = limits;
		provider.link.host.count("references", 1);
		objectsMetrics(provider.link.host.telemetry.metrics).upDownCounter("objects.holds.active").add(1);
	}
	get version(): number | undefined {
		return this.#request?.version;
	}
	get fingerprint(): string | undefined {
		return this.#request?.fingerprint;
	}
	get callable(): boolean {
		return this.#names() !== undefined;
	}
	get refusal(): ObjectsError {
		const state = this.#status;
		if (state.kind === "refused") return state.cause.error;
		if (state.kind === "pending" && state.told) return state.told;
		return new ObjectsError({ code: "not_ready", message: `hold ${this.id}: not bound yet` });
	}
	#names(): BoundNames | undefined {
		const state = this.#status;
		if (state.kind === "bound") {
			if (state.previous && !this.#side.acknowledged(state.previous.until)) return state.previous;
			return state;
		}
		return state.kind === "binding" || state.kind === "pending" ? state.previous : undefined;
	}
	get bound(): boolean {
		return this.#status.kind === "bound";
	}
	get principal(): Principal | undefined {
		return this.caller.principal;
	}
	get unbound(): boolean {
		return !this.#object && this.#status.kind !== "released";
	}
	start(request: HoldRequest): void {
		const { link } = this.#side;
		if (!link.host.published) {
			this.#status = { kind: "unplaced", request: ownRequest(request) };
			link.host.index(request.type, this);
			return;
		}
		let served: Serving;
		try {
			const large = oversized(request.params, link.limits.part);
			if (large) throw large;
			const destination = link.host.place(request, link, this.caller, link.context);
			if (destination.kind === "path") {
				this.drop();
				new RelayedHold(this.id, this.#side, request, this.caller, destination.path).start();
				return;
			}
			let params: unknown;
			try {
				params = parsePart(link.openPart(request.params, this.limits, link.context));
			} catch (error) {
				if (isObjectsError(error, "too_large")) throw error;
				link.host.report({ kind: "protocol_error", error });
				link.close();
				return;
			}
			served = link.host.serving(request, params, this.caller.principal!, link.context);
		} catch (error) {
			this.#refuse(request, { kind: "broken", error: asObjectsError(error, request.type) });
			return;
		}
		if (served.kind === "waiting") {
			this.#refuse(request, served.cause);
			return;
		}
		this.#request = ownRequest(request);
		this.#object = served.object;
		served.object.hold(this);
		this.moved();
	}
	wake(): void {
		const state = this.#status;
		if (state.kind === "unplaced") {
			this.#status = pending;
			this.start(state.request);
		} else if (state.kind === "refused") this.#restart(state.request);
	}
	moved(): void {
		const previous = this.#status;
		const object = this.#object;
		if (object === undefined) return;
		const shown = object.stateFor(this.#request!.version, this.#request!.fingerprint);
		if (previous.kind === "bound" || previous.kind === "binding") {
			if (shown.kind === "live") {
				if (previous.kind === "bound" && previous.instance !== object.instance) {
					const names = this.#names();
					this.#unfollow(previous);
					this.#side.unbind(this);
					this.#status = { kind: "binding", ...(names ? { previous: names } : {}) };
					this.#side.bind(this, this.#side.link.context);
				}
				return;
			}
			if (previous.kind === "bound" && object.attachable === previous.instance) return;
			const names = this.#names();
			if (previous.kind === "bound") this.#unfollow(previous);
			const error = shown.kind === "failed" ? shown.cause.error : undefined;
			if (error) this.#side.unbound(this, error);
			else this.#side.unbind(this);
			this.#status = { kind: "pending", ...(!error && names ? { previous: names } : {}) };
			if (error === undefined) this.#side.send({ kind: "loading", hold: this.id });
		}
		if (this.#status.kind !== "pending") return;
		const state = shown;
		switch (state.kind) {
			case "live":
				this.#status = { kind: "binding", ...(this.#status.previous ? { previous: this.#status.previous } : {}) };
				this.#side.bind(this, this.#side.link.context);
				break;
			case "failed":
				this.#side.send({
					kind: "failed",
					hold: this.id,
					cause: { kind: state.cause.kind, error: wireError(state.cause.error) },
					...(state.retryAt === undefined ? {} : { retryIn: Math.max(0, state.retryAt - Date.now()) }),
				});
				this.#status = { kind: "pending", told: state.cause.error };
				break;
			case "loading":
				if (this.#status.told) {
					this.#side.send({ kind: "loading", hold: this.id });
					this.#status = pending;
				}
				break;
		}
	}
	retry(message: Extract<Message, { kind: "retry" }>): void {
		const state = this.#status;
		if (state.kind !== "refused") {
			this.#object?.retry(retryOperation(message.hops - 1));
			return;
		}
		if (state.cause.kind === "waiting") this.#side.link.host.unindex(state.request.type, this);
		this.#restart(state.request);
	}
	call(method: string, args: unknown, context: Context, parent?: TelemetryContext): Promise<unknown> {
		return this.#object!.call(method, args, context, this.caller, this.#request!.version, parent);
	}
	method(index: number): { readonly name: string; readonly resultBytes: boolean } {
		const state = this.#names(),
			name = state?.names.methods[index];
		if (state === undefined || name === undefined) throw new Error(`hold ${this.id}: no method ${index}`);
		return { name, resultBytes: state.variant.methods.get(name)!.result.bytes };
	}
	boundEntry(context: Context): BoundEntry {
		const previous = this.#names();
		const object = this.#object!,
			contract = object.contractFor(this.#request!.version, this.#request!.fingerprint),
			variant = object.variant!,
			data = variantsAt(contract, this.#request!.version).get(variant)!;
		const state: Bound = {
			kind: "bound",
			instance: object.instance,
			variant: data,
			names: variantNames(data),
			followed: [],
			...(previous ? { previous: { ...previous, until: this.#side.nextOwn } } : {}),
		};
		this.#status = state;
		const members: BoundEntry["members"][number][] = [],
			failed: FailedMember[] = [];
		for (const name of data.state.keys()) {
			const source = object.member(name, this.#request!.version);
			const index = state.names.state.indexOf(name);
			let value: JsonValue;
			try {
				value = source.value;
			} catch (error) {
				failed.push({ member: index, error: wireError(error) });
				if (source instanceof Source) this.#subscribe(state, index, source);
				continue;
			}
			try {
				members.push({ member: index, value: this.#side.link.part(jsonPart(value), context) });
			} catch (error) {
				failed.push({ member: index, error: wireError(error) });
				continue;
			}
			if (source instanceof Source) this.#subscribe(state, index, source);
		}
		this.#updates = [];
		this.#failures = [];
		this.#retirements = NO_RETIRED;
		objectsMetrics(context.telemetry.metrics).counter("objects.link.encodes").add(1);
		return {
			hold: this.id,
			variant: variantOrder(contract).indexOf(variant),
			members,
			failed,
		};
	}
	entry(context: Context): StateEntry {
		return this.#finish(
			this.#take().map(([subscription, ops]) => ({
				member: subscription.index,
				ops: this.#encode(subscription, ops, context),
			})),
			context,
		);
	}
	queue(): void {
		for (const [subscription, ops] of this.#take()) subscription.pending.push(ops);
	}
	pendingEntry(context: Context): StateEntry {
		const members: StateEntry["members"][number][] = [];
		for (const subscription of (this.#status as Bound).followed) {
			if (!subscription.pending.size) continue;
			const taken = subscription.pending.take(),
				ops = taken.kind === "replace" ? [["r", subscription.source.value] as const] : taken.ops;
			if (ops.length) members.push({ member: subscription.index, ops: this.#encode(subscription, ops, context) });
		}
		return this.#finish(members, context);
	}
	removed(cause: FailureCause): void {
		const object = this.#object;
		this.#object = undefined;
		object?.unhold(this);
		if (this.#status.kind === "bound") this.#unfollow(this.#status);
		this.#side.unbound(this, cause.error);
		this.#refuse(this.#request!, cause);
	}
	#unfollow(state: Bound): void {
		for (const item of state.followed) item.source.unsubscribe(item.subscriber);
		this.#updates = [];
		this.#failures = [];
		this.#retirements = NO_RETIRED;
		this.#dirty = false;
	}
	release(): void {
		this.drop();
		this.#object?.unhold(this);
		this.#object = undefined;
	}
	drop(): void {
		const state = this.#status,
			host = this.#side.link.host;
		if (state.kind === "bound") for (const item of state.followed) item.source.unsubscribe(item.subscriber);
		else if (state.kind === "unplaced" || (state.kind === "refused" && state.cause.kind === "waiting"))
			host.unindex(state.request.type, this);
		this.#status = { kind: "released" };
		if (this.#counted) {
			host.count("references", -1);
			objectsMetrics(host.telemetry.metrics).upDownCounter("objects.holds.active").add(-1);
		}
		this.#counted = false;
	}
	end(error: ObjectsError): void {
		if (this.#status.kind === "released") return;
		this.#side.forget(this, error);
		this.drop();
		this.#object = undefined;
		this.#side.send({ kind: "gone", hold: this.id, error: wireError(error) });
	}
	#restart(request: HoldRequest): void {
		this.#status = pending;
		this.#side.send({ kind: "loading", hold: this.id });
		this.start(request);
	}
	#refuse(request: HoldRequest, cause: FailureCause): void {
		this.#status = { kind: "refused", request: ownRequest(request), cause };
		if (cause.kind === "waiting") this.#side.link.host.index(request.type, this, cause);
		this.#side.send({ kind: "failed", hold: this.id, cause: { kind: cause.kind, error: wireError(cause.error) } });
	}
	#subscribe(state: Bound, index: number, source: Source): void {
		const subscription: Subscription = {
			index,
			source,
			encoder: encoder(),
			pending: new PendingOps(),
			subscriber: {
				advance: (call) => {
					if (!this.#dirty) {
						this.#dirty = true;
						this.#side.touched(this);
					}
					if (call.kind === "failed") {
						subscription.pending.take();
						const failure = { member: index, error: wireError(call.error) },
							position = this.#failures.findIndex((item) => item.member === index);
						if (position < 0) this.#failures.push(failure);
						else this.#failures = this.#failures.map((item, i) => (i === position ? failure : item));
					} else {
						if (this.#failures.length) this.#failures = this.#failures.filter((item) => item.member !== index);
						if (call.ops.length) this.#updates.push([subscription, call.ops]);
						if (call.retired && !this.#retirements.includes(index)) this.#retirements = [...this.#retirements, index];
					}
				},
				end() {},
				endAfterDelivery() {},
			},
		};
		source.subscribe(subscription.subscriber);
		state.followed.push(subscription);
	}
	#take(): (readonly [Subscription, readonly Op[]])[] {
		const changes = this.#updates;
		this.#updates = [];
		this.#dirty = false;
		return changes;
	}
	#encode(subscription: Subscription, ops: readonly Op[], context: Context) {
		return this.#side.link.part(jsonPart(subscription.encoder.encode(ops)), context);
	}
	#finish(members: StateEntry["members"], context: Context): StateEntry {
		const failed = this.#failures,
			retired = this.#retirements;
		this.#failures = [];
		this.#retirements =
			retired.length && failed.length
				? retired.filter((index) => failed.some((item) => item.member === index))
				: NO_RETIRED;
		const sent = this.#retirements.length ? retired.filter((index) => !this.#retirements.includes(index)) : retired;
		objectsMetrics(context.telemetry.metrics).counter("objects.link.encodes").add(1);
		return { hold: this.id, members, failed, retired: sent };
	}
}
function ownRequest(request: HoldRequest): HoldRequest {
	return typeof request.params === "string" ? request : { ...request, params: (request.params as Uint8Array).slice() };
}
export function actingFor(link: HostLink, caller: Caller): Pick<HoldMessage, "principal" | "incarnation"> {
	return link.role === "route" && caller.principal !== undefined
		? { principal: caller.principal, incarnation: caller.incarnation }
		: {};
}
