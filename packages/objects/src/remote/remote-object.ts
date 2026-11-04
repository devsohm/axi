import type { TelemetryCarrier, TelemetrySpan } from "@axi/telemetry";
import { BACKGROUND_CONTEXT, withTelemetry, type Context } from "../context/index.ts";
import { OpenSpan, carrierOf, parentOf, ended, spanFailed, untraced } from "../telemetry.ts";
import type { JsonValue } from "../json.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import {
	currentVariants,
	type MethodData,
	type VariantNames,
	variantNames,
	variantOrder,
} from "../contracts/internal.ts";
import { ObjectsError } from "../data/index.ts";
import { asObjectsError, invalid } from "../data/internal.ts";
import type { AnyHost } from "../host/host.ts";
import type { Caller } from "../host/ctx.ts";
import type { ObjectsObject } from "../host/object.ts";
import { LIVE, LOADING, type RefState } from "../host/ref-state.ts";
import type { Binding, CheckedParams, PinnedKey, RetryOperation, Target } from "../host/reference.ts";
import {
	type BoundEntry,
	errorFromWire,
	jsonPart,
	type Message,
	parsePart,
	type StateEntry,
	type WireAddress,
} from "../link/internal.ts";
import type { DeriveSource } from "../state/internal.ts";
import type { ConsumerSide } from "./consumer.ts";
import type { HoldRequest } from "./hold.ts";
import type { HostLink } from "./host-link.ts";
import type { Path } from "./path.ts";
import { type MemberSnapshot, Replica } from "./replica.ts";
type Bound = {
	readonly variant: string;
	readonly methods: ReadonlyMap<string, MethodData>;
	readonly names: VariantNames;
	readonly replicas: ReadonlyMap<string, Replica>;
};
export class RemoteObject implements Target {
	readonly kind = "remote";
	readonly label: string;
	readonly contract: Contract;
	readonly request: HoldRequest;
	readonly caller: Caller;
	readonly #host: AnyHost;
	readonly #params: ParamsOf<Contract>;
	#path: Path;
	#dependent: ObjectsObject | undefined;
	#status: RefState = LOADING;
	#snapshot: Bound | undefined;
	#connection: { readonly side: ConsumerSide; readonly id: number } | undefined;
	#reference: Binding | undefined;
	#failure: ObjectsError | undefined;
	#holding?: OpenSpan;
	#firstHold?: TelemetryCarrier;
	#holds = 0;
	constructor(
		host: AnyHost,
		contract: Contract,
		checked: CheckedParams,
		address: WireAddress,
		caller: Caller,
		path: Path,
		dependent: ObjectsObject | undefined,
		context: Context = BACKGROUND_CONTEXT,
	) {
		this.#host = host;
		this.contract = contract;
		this.label = checked.key ? `${contract.name}(${checked.key})` : contract.name;
		if (!untraced(context.telemetry)) {
			this.#holding = new OpenSpan(context.telemetry, "objects.hold", {
				"objects.host": host.spanHost, type: contract.name, object: this.label.slice(0, 256), "address.kind": address.kind,
			});
			this.#firstHold = carrierOf(this.#holding.span);
		}
		this.request = {
			type: contract.name,
			version: contract.version,
			fingerprint: contract.fingerprint,
			params: jsonPart(checked.params),
			address,
		};
		this.caller = caller;
		this.#params = checked.params;
		this.#path = path;
		this.#dependent = dependent;
	}
	get state(): RefState {
		return this.#status;
	}
	get span(): TelemetrySpan | undefined { return this.#holding?.span; }
	holdTrace(): TelemetryCarrier | undefined {
		if (this.#holds++ === 0) return this.#firstHold;
		const adapter = this.#host.telemetry;
		if (!this.#firstHold || untraced(adapter)) return;
		this.#held("ended");
		this.#holding = new OpenSpan(adapter, "objects.hold", {
			"objects.host": this.#host.spanHost, type: this.contract.name, object: this.label.slice(0, 256), "address.kind": this.request.address.kind,
		});
		this.#holding.span.addLink({ context: parentOf(this.#firstHold, adapter) });
		return carrierOf(this.#holding.span);
	}
	get heldOnLink(): boolean {
		return this.#connection !== undefined;
	}
	get blocksFirstPass(): false {
		return false;
	}
	get lastFailure(): ObjectsError | undefined {
		return this.#failure;
	}
	get variant(): string | undefined {
		return this.#snapshot?.variant;
	}
	get hydrated(): boolean {
		return this.#snapshot !== undefined;
	}
	get lastValues(): false {
		return false;
	}
	get activationId(): undefined {
		return undefined;
	}
	pathTo(): undefined {
		return undefined;
	}
	hold(binding: Binding): void {
		this.#reference = binding;
	}
	unhold(_binding: Binding): void {
		const error = new ObjectsError({ code: "released", message: `${this.label}: released` });
		this.#connection?.side.release(this.#connection.id, error);
		this.#end(error);
	}
	attach(link: HostLink): void {
		this.#connection = { side: link.consumer, id: link.consumer.attach(this, this.#dependent?.activationChain(), this.holdTrace()) };
		this.#dependent?.dependencyMoved();
	}
	dropped(_error: ObjectsError): void {
		this.#connection = undefined;
		this.loading();
		this.#dependent?.dependencyMoved();
	}
	unreachable(error: ObjectsError): void {
		this.#held("failed", error);
		this.#failure = error;
		if (this.#status.kind !== "ended")
			this.#move({ kind: "failed", cause: { kind: "waiting", error }, retryAt: undefined });
	}
	async call(name: string, args: unknown, context: Context): Promise<unknown> {
		const snapshot = this.#snapshot!,
			method = snapshot.methods.get(name);
		if (!method) throw invalid("member", `${this.label} (variant ${snapshot.variant}) has no method "${name}"`);
		const parent = context.telemetry;
		if (untraced(parent)) return this.#connection!.side.call(this.#connection!.id, snapshot.names.methods.indexOf(name), method, args, context);
		return parent.startSpan({ name: "objects.call", attributes: {
			"objects.host": this.#host.spanHost, type: this.contract.name, object: this.label.slice(0, 256), member: name,
			"address.kind": this.request.address.kind, ...this.#host.principalAttributes(this.caller.principal, context),
		} }, async (span) => {
		try {
		const value = await this.#connection!.side.call(
			this.#connection!.id,
			snapshot.names.methods.indexOf(name),
			method,
			args,
			withTelemetry(span, context),
		);
		span.setAttributes({ outcome: "ok" });
		return value;
		} catch (error) { span.setAttributes({ outcome: ended(span, "call_failed", error, context.abortSignal) }); throw error; }
		});
	}
	member(name: string): DeriveSource {
		const snapshot = this.#snapshot;
		if (!snapshot) throw new ObjectsError({ code: "not_ready", message: `${this.label}: not bound yet` });
		const replica = snapshot.replicas.get(name);
		if (!replica) throw this.#missing(name, snapshot.variant);
		return replica;
	}
	async pinKey(name: string): Promise<PinnedKey> {
		return this.keyedMember(name);
	}
	keyedMember(name: string): never {
		throw invalid("member", `${this.label} has no keyed member "${name}": keyed members are local`);
	}
	retry(operation: RetryOperation): void {
		if (this.#status.kind !== "failed") return;
		if (this.#path !== this.#host.unplaced) {
			if (operation.hops > 0) this.#connection?.side.retry(this.#connection.id, operation);
			return;
		}
		let path: Path;
		try {
			path = this.#host.pathOf(this.contract, this.#params, this.caller.principal);
		} catch (error) {
			this.#broken(asObjectsError(error, this.contract.name));
			return;
		}
		this.#path.detach(this);
		this.#path = path;
		this.#move(LOADING);
		path.attach(this);
	}
	tooLarge(error: ObjectsError): void {
		const connection = this.#connection;
		if (!connection) return;
		this.#connection = undefined;
		connection.side.release(connection.id, error);
		this.#path.detach(this);
		this.#path = this.#host.unplaced;
		this.#path.attach(this);
		this.#broken(error);
	}
	prepareBound(entry: BoundEntry, link: HostLink): () => void {
		const variant = variantOrder(this.contract)[entry.variant];
		if (variant === undefined) throw new Error(`hold ${entry.hold}: no variant ${entry.variant}`);
		const definition = currentVariants(this.contract).get(variant)!,
			names = variantNames(definition),
			snapshots = new Map<string, MemberSnapshot>();
		const add = (index: number, snapshot: MemberSnapshot): void => {
			const name = names.state[index];
			if (name === undefined || snapshots.has(name)) throw new Error(`hold ${entry.hold}: member ${index} in bound`);
			snapshots.set(name, snapshot);
		};
		for (const item of entry.members)
			add(item.member, {
				kind: "value",
				value: parsePart(link.openPart(item.value, link.limits, link.context)) as JsonValue,
			});
		for (const item of entry.failed) add(item.member, { kind: "failed", error: errorFromWire(item.error) });
		if (snapshots.size !== names.state.length) throw new Error(`hold ${entry.hold}: the snapshot misses a member`);
		return () => {
			const old = this.#snapshot?.replicas,
				replicas = new Map<string, Replica>();
			this.#snapshot = { variant, methods: definition.methods, names, replicas };
			for (const [name, value] of snapshots) {
				const previous = old?.get(name);
				if (previous) {
					previous.reset(value);
					replicas.set(name, previous);
				} else replicas.set(name, new Replica(this.#host.batch, value));
			}
			for (const [name, previous] of old ?? [])
				if (!snapshots.has(name)) {
					previous.vanish(this.#missing(name, variant));
					replicas.set(name, previous);
				}
		};
	}
	wentLive(): void {
		this.#held("bound");
		this.#failure = undefined;
		this.#move(LIVE);
	}
	failed(message: Extract<Message, { kind: "failed" }>): void {
		const error = asObjectsError(errorFromWire(message.cause.error), this.label);
		this.#held("failed", error);
		this.#failure = error;
		this.#move({
			kind: "failed",
			cause: { kind: message.cause.kind, error },
			retryAt: message.retryIn === undefined ? undefined : Date.now() + message.retryIn,
		});
	}
	loading(): void {
		if (this.#status.kind !== "ended" && this.#status.kind !== "loading") this.#move(LOADING);
	}
	prepare(entry: StateEntry, link: HostLink): () => void {
		const snapshot = this.#snapshot;
		if (!snapshot || this.#status.kind !== "live") throw new Error(`hold ${entry.hold}: state before bound`);
		const at = (index: number): Replica => {
			const name = snapshot.names.state[index],
				replica = name === undefined ? undefined : snapshot.replicas.get(name);
			if (!replica) throw new Error(`hold ${entry.hold}: no state member ${index}`);
			return replica;
		};
		let retired: Set<Replica> | undefined;
		for (const index of entry.retired) {
			const replica = at(index);
			retired ??= new Set();
			if (retired.has(replica)) throw new Error(`hold ${entry.hold}: member ${index} retired twice in one state`);
			retired.add(replica);
		}
		const seen = new Set<Replica>();
		const changes = entry.members.map((item) => {
			const replica = at(item.member);
			if (seen.has(replica)) throw new Error(`hold ${entry.hold}: member ${item.member} twice in one state`);
			seen.add(replica);
			return { replica, ...replica.decode(parsePart(link.openPart(item.ops, link.limits, link.context))) };
		});
		const failed = entry.failed.map((item) => ({ replica: at(item.member), error: errorFromWire(item.error) }));
		return () => {
			for (const item of changes) item.replica.adopt(item.value, item.ops, retired?.has(item.replica) === true);
			for (const item of failed) item.replica.fail(item.error);
			for (const replica of retired ?? []) if (!seen.has(replica)) replica.retireAlone();
		};
	}
	revoke(error: ObjectsError): void {
		const connection = this.#connection;
		this.#connection = undefined;
		connection?.side.release(connection.id, error);
		this.lost(error);
	}
	lost(error: ObjectsError): void {
		const reference = this.#reference;
		this.#connection?.side.forget(this.#connection.id, error);
		this.#end(error);
		reference?.end(error);
	}
	#end(error: ObjectsError): void {
		this.#held("ended");
		const snapshot = this.#snapshot;
		this.#status = { kind: "ended", error };
		this.#reference = undefined;
		this.#dependent = undefined;
		this.#connection = undefined;
		this.#snapshot = undefined;
		this.#path.detach(this);
		for (const replica of snapshot?.replicas.values() ?? []) replica.end(error);
	}
	#move(state: RefState): void {
		this.#status = state;
		this.#reference?.retarget();
		this.#reference?.moved();
	}
	#broken(error: ObjectsError): void {
		this.#held("failed", error);
		this.#failure = error;
		this.#move({ kind: "failed", cause: { kind: "broken", error }, retryAt: undefined });
	}
	#held(outcome: "bound" | "failed" | "ended", error?: ObjectsError): void {
		const holding = this.#holding;
		if (!holding) return;
		this.#holding = undefined;
		holding.span.setAttributes({ outcome });
		if (error) spanFailed(holding.span, "hold_failed", error);
		holding.end();
	}
	#missing(name: string, variant: string): ObjectsError {
		return invalid("member", `${this.label} (variant ${variant}) has no state member "${name}"`);
	}
}
