import { contractFromDescription, LOCAL_VARIANT, resolveHost } from "./contract.ts";
import { type Encoder, encoder } from "./delta/index.ts";
import { ChordError, invalid } from "./errors.ts";
import type { HostImpl } from "./host.ts";
import { type Link, Packed, unpack } from "./link.ts";
import { type CtxImpl, RefImpl, variantOf } from "./object.ts";
import type { RemoteBinding, RemoteChannel } from "./remote.ts";
import { assertValid } from "./schema.ts";
import type { Ctx, Readable, Shape, StateEvent } from "./types.ts";
import { type Frame, fromWireError, isFrame, PROTOCOL_VERSION, type RootRef, toWireError } from "./wire.ts";

export interface LinkOptions {
	readonly pingInterval?: number;
	readonly pingTimeout?: number;
	readonly window?: number;
	readonly pendingCap?: number;
	readonly onProtocolMismatch?: (versions: { readonly local: number; readonly peer: number | undefined }) => void;
}
export interface AcceptOptions<P = unknown> extends LinkOptions {
	readonly principal: P;
	readonly kind?: "host" | "client";
	readonly name?: string;
	restamp?(principal: P): P | undefined;
	readonly maxCalls?: number;
}
export interface Peer {
	readonly kind: "host" | "client";
	readonly name: string | undefined;
}
type StateFrame = Extract<Frame, { t: "state" }>;
type Pending = { resolve(value: unknown): void; reject(error: unknown): void };
type Overflow = { readonly resend: () => void } | { readonly resync: () => void };
type Slot =
	| { kind: "unit"; hold: number; flush(): void }
	| {
			kind: "state";
			hold: number;
			m: string;
			base: StateFrame | undefined;
			ops: (readonly unknown[])[];
			size: number;
			lazy: boolean;
			overflow: Overflow;
	  };
type Feed = { unsubscribe(): void; encoder: Encoder; buffer: StateEvent<unknown>[] | undefined };
interface ServedLocal {
	kind: "local";
	id: number;
	ref: RefImpl;
	principal: unknown;
	origin: string | undefined;
	wantsState: boolean;
	again: boolean;
	unitSent: boolean;
	feeds: Map<string, Feed>;
}
type Served = ServedLocal | { kind: "relay"; relay: RelayRef };
const unavailable = (message: string): ChordError => new ChordError("unavailable", message);
const stateKey = (hold: number, member: string): string => `s${hold}\0${member}`;
const unitKey = (hold: number): string => `u${hold}`;

export class RelayRef {
	readonly origin: Connection;
	readonly frame: Extract<Frame, { t: "hold" }>;
	readonly principal: unknown;
	readonly originTag: string | undefined;
	readonly generation: number;
	down: Connection | undefined;
	downId = 0;
	closed = false;
	stateWanted: boolean;
	urgent: Set<string> | undefined;
	readonly awaiting = new Set<string>();
	readonly calls = new Map<number, RelayCall>();
	readonly #waiting = new Set<{ resolve(value: Connection): void; reject(error: unknown): void }>();
	#shaped = false;
	constructor(
		origin: Connection,
		frame: Extract<Frame, { t: "hold" }>,
		principal: unknown,
		originTag: string | undefined,
	) {
		this.origin = origin;
		this.frame = frame;
		this.principal = principal;
		this.originTag = originTag;
		this.generation = origin.generation;
		this.stateWanted = frame.state !== false;
	}
	get originId(): number {
		return this.frame.id;
	}
	get client(): boolean {
		return this.originTag !== undefined;
	}
	get current(): boolean {
		return !this.closed && this.origin.open && this.generation === this.origin.generation;
	}
	ready(): Promise<Connection> {
		if (this.closed) return Promise.reject(new ChordError("gone", "relayed hold closed"));
		if (this.down) return Promise.resolve(this.down);
		return new Promise<Connection>((resolve, reject) => {
			this.#waiting.add({ resolve, reject });
		});
	}
	open(down: Connection): void {
		if (this.closed) return;
		this.down = down;
		this.downId = down.nextId();
		down.relayedRefs.set(this.downId, this);
		down.send({
			t: "hold",
			id: this.downId,
			at: this.frame.at,
			token: this.frame.token,
			input: this.frame.input,
			principal: this.principal,
			...(this.originTag === undefined ? {} : { origin: this.originTag }),
			...(this.stateWanted ? {} : { state: false as const }),
			...(this.frame.again ? { again: true as const } : {}),
		});
		for (const pending of this.#waiting) pending.resolve(down);
		this.#waiting.clear();
	}
	wantState(wanted: boolean): void {
		if (this.closed || wanted === this.stateWanted) return;
		this.stateWanted = wanted;
		if (!wanted) {
			this.origin.dropHoldState(this.originId);
			this.awaiting.clear();
		}
		this.down?.send({ t: wanted ? "sub" : "unsub", hold: this.downId });
	}
	resync(member: string): void {
		if (!this.closed) {
			this.awaiting.add(member);
			this.down?.send({ t: "resync", hold: this.downId, m: member });
		}
	}
	shape(frame: Extract<Frame, { t: "shape" }>): void {
		if (this.closed) return;
		if (!this.#shaped) {
			this.#shaped = true;
			if (!this.frame.again) this.urgent = new Set(frame.state);
		}
		this.origin.send({ ...frame, id: this.originId });
	}
	state(frame: StateFrame): void {
		if (this.closed) return;
		if (this.awaiting.has(frame.m)) {
			if (frame.as === "ops") return;
			this.awaiting.delete(frame.m);
		}
		const out = { ...frame, hold: this.originId };
		if (this.urgent?.delete(frame.m)) this.origin.send(out);
		else this.origin.sendState(out, { resync: () => this.resync(frame.m) });
	}
	close(error: unknown, options: { readonly releaseDown: boolean; readonly notify: boolean }): void {
		if (this.closed) return;
		this.closed = true;
		for (const call of [...this.calls.values()]) call.cancel(error, options.releaseDown);
		this.origin.dropHoldState(this.originId);
		if (this.origin.served.get(this.originId)?.kind === "relay") this.origin.served.delete(this.originId);
		if (this.down) {
			this.down.relayedRefs.delete(this.downId);
			if (options.releaseDown) this.down.send({ t: "release", id: this.downId });
		}
		for (const pending of this.#waiting) pending.reject(error);
		this.#waiting.clear();
		if (options.notify) this.origin.send({ t: "gone", id: this.originId, error: toWireError(error) });
	}
}
export class RelayCall {
	readonly relay: RelayRef;
	readonly originId: number;
	readonly downId: number;
	readonly #pending: Pending;
	#settled = false;
	constructor(relay: RelayRef, originId: number, downId: number, pending: Pending) {
		this.relay = relay;
		this.originId = originId;
		this.downId = downId;
		this.#pending = pending;
		relay.calls.set(originId, this);
		relay.down?.relayedCalls.set(downId, this);
	}
	finish(error: unknown, value?: unknown): void {
		if (this.#settled) return;
		this.#settled = true;
		this.relay.calls.delete(this.originId);
		this.relay.down?.relayedCalls.delete(this.downId);
		if (error === undefined) this.#pending.resolve(value);
		else this.#pending.reject(error);
	}
	cancel(error: unknown, forward: boolean): void {
		if (!this.#settled) {
			if (forward) this.relay.down?.send({ t: "cancel", id: this.downId });
			this.finish(error);
		}
	}
}

export class Connection implements RemoteChannel {
	readonly host: HostImpl;
	readonly link: Link;
	readonly role: "upstream" | "downstream";
	readonly peer: Peer;
	readonly originId: string | undefined;
	readonly restamp: ((principal: unknown) => unknown | undefined) | undefined;
	principal: unknown;
	generation = 0;
	peerCodeVersion: number | undefined;
	synced: boolean;
	readonly fencedCodeVersions = new Set<number>();
	readonly remotes = new Map<number, RemoteBinding>();
	readonly calls = new Map<number, Pending>();
	readonly served = new Map<number, Served>();
	readonly incoming = new Map<number, AbortController>();
	readonly relayedRefs = new Map<number, RelayRef>();
	readonly relayedCalls = new Map<number, RelayCall>();
	readonly votes = new Map<number, Pending>();
	readonly #admitted = new Map<string, number>();
	readonly #sync = new Set<Pending>();
	readonly #pending = new Map<string, Slot>();
	readonly #window: number;
	readonly #cap: number;
	readonly #maxCalls: number;
	readonly #mismatch: LinkOptions["onProtocolMismatch"];
	#parentName: string | undefined;
	#id = 1;
	#seen = Date.now();
	#pinger: ReturnType<typeof setInterval> | undefined;
	#ackTimer: ReturnType<typeof setTimeout> | undefined;
	#peerAcks: boolean | undefined;
	#sent = 0;
	#acked = 0;
	#received = 0;
	#unacked: number[] = [];
	#bytes = 0;
	#waitingBytes = 0;
	#mismatched = false;
	constructor(
		host: HostImpl,
		link: Link,
		config: {
			role: "upstream" | "downstream";
			principal: unknown;
			peer: Peer;
			originId?: string;
			restamp?: (principal: unknown) => unknown | undefined;
			maxCalls?: number;
		} & LinkOptions,
	) {
		this.host = host;
		this.link = link;
		this.role = config.role;
		this.peer = config.peer;
		this.originId = config.originId;
		this.principal = config.principal;
		this.restamp = config.restamp;
		this.synced = !(config.role === "downstream" && config.peer.kind === "host");
		this.#window = config.window ?? 262144;
		this.#cap = config.pendingCap ?? this.#window * 4;
		this.#maxCalls = config.maxCalls ?? Infinity;
		this.#mismatch = config.onProtocolMismatch;
		link.onClose((reason) => this.#closed(reason));
		link.receive((frame) => this.#receive(frame));
		this.send({
			t: "hello",
			protocol: PROTOCOL_VERSION,
			name: host.name,
			kind: host.kind,
			codeVersion: host.current.id,
			acks: true,
		});
		const interval = config.pingInterval ?? 15000;
		const timeout = config.pingTimeout ?? 45000;
		if (link.closed) return;
		let n = 0;
		this.#pinger = setInterval(() => {
			if (Date.now() - this.#seen > timeout) link.close("ping timeout");
			else this.send({ t: "ping", n: ++n });
		}, interval);
		this.#pinger.unref?.();
	}
	get open(): boolean {
		return !this.link.closed;
	}
	get name(): string | undefined {
		return this.role === "upstream" ? this.#parentName : this.peer.name;
	}
	nextId(): number {
		return this.#id++;
	}
	send(frame: Frame): void {
		const bytes = this.link.send(frame) ?? 0;
		if (this.#peerAcks === false) return;
		this.#sent++;
		this.#unacked.push(bytes);
		this.#bytes += bytes;
	}
	get #full(): boolean {
		return this.#peerAcks === true && this.#bytes >= this.#window;
	}
	get waiting(): { readonly slots: number; readonly bytes: number } {
		return { slots: this.#pending.size, bytes: this.#waitingBytes };
	}
	sendState(frame: StateFrame, overflow: Overflow): void {
		const key = stateKey(frame.hold, frame.m);
		let slot = this.#pending.get(key);
		if (!slot && !this.#full) {
			this.send(frame);
			return;
		}
		if (slot?.kind === "unit") return;
		if (!slot) {
			slot = { kind: "state", hold: frame.hold, m: frame.m, base: undefined, ops: [], size: 0, lazy: false, overflow };
			this.#pending.set(key, slot);
		}
		if (frame.as !== "ops") {
			this.#waitingBytes -= slot.size;
			slot.base = frame;
			slot.ops = [];
			slot.size = 0;
			slot.lazy = false;
			return;
		}
		if (slot.lazy) return;
		const size = JSON.stringify(frame.ops).length;
		if (this.#waitingBytes + size > this.#cap) {
			for (const other of [...this.#pending.values()]) {
				if (this.#waitingBytes + size <= this.#cap) break;
				if (other.kind === "state" && other !== slot && other.size > 0) this.#drop(other);
			}
			if (this.#waitingBytes + size > this.#cap) this.#drop(slot);
		}
		if (slot.lazy || this.#pending.get(key) !== slot) return;
		for (const op of frame.ops ?? []) slot.ops.push(op);
		slot.size += size;
		this.#waitingBytes += size;
	}
	#drop(slot: Extract<Slot, { kind: "state" }>): void {
		this.#waitingBytes -= slot.size;
		slot.base = undefined;
		slot.ops = [];
		slot.size = 0;
		if ("resend" in slot.overflow) slot.lazy = true;
		else {
			this.#pending.delete(stateKey(slot.hold, slot.m));
			slot.overflow.resync();
		}
	}
	dropState(hold: number, member: string): void {
		const key = stateKey(hold, member),
			slot = this.#pending.get(key);
		if (slot?.kind === "state") {
			this.#waitingBytes -= slot.size;
			this.#pending.delete(key);
		}
	}
	dropHoldState(hold: number): void {
		for (const [key, slot] of this.#pending)
			if (slot.hold === hold) {
				if (slot.kind === "state") this.#waitingBytes -= slot.size;
				this.#pending.delete(key);
			}
	}
	#resetLater(hold: number, member: string, resend: () => void): void {
		const key = stateKey(hold, member);
		let slot = this.#pending.get(key);
		if (slot?.kind === "unit") return;
		if (!slot) {
			slot = { kind: "state", hold, m: member, base: undefined, ops: [], size: 0, lazy: true, overflow: { resend } };
			this.#pending.set(key, slot);
		} else {
			this.#waitingBytes -= slot.size;
			slot.base = undefined;
			slot.ops = [];
			slot.size = 0;
			slot.lazy = true;
		}
		this.#flush();
	}
	#queueUnit(hold: number, flush: () => void): void {
		const key = unitKey(hold);
		if (!this.#pending.has(key)) this.#pending.set(key, { kind: "unit", hold, flush });
		this.#flush();
	}
	#flush(): void {
		for (const [key, slot] of this.#pending) {
			if (this.#full) return;
			this.#pending.delete(key);
			if (slot.kind === "unit") {
				slot.flush();
				continue;
			}
			this.#waitingBytes -= slot.size;
			if (slot.lazy) {
				if ("resend" in slot.overflow) slot.overflow.resend();
				continue;
			}
			if (slot.base) this.send(slot.base);
			if (slot.ops.length) this.send({ t: "state", hold: slot.hold, m: slot.m, as: "ops", ops: slot.ops });
		}
	}
	#onAck(n: number): void {
		if (this.#peerAcks !== true || n < this.#acked || n > this.#sent) {
			this.#violation(`ack ${n} outside ${this.#acked}..${this.#sent}`);
			return;
		}
		for (const bytes of this.#unacked.splice(0, n - this.#acked)) this.#bytes -= bytes;
		this.#acked = n;
		this.#flush();
	}
	#scheduleAck(): void {
		if (this.#peerAcks !== true || this.#ackTimer !== undefined || !this.open) return;
		this.#ackTimer = setTimeout(() => {
			this.#ackTimer = undefined;
			this.link.send({ t: "ack", n: this.#received });
		}, 0);
		this.#ackTimer.unref?.();
	}
	whenSynced(): Promise<void> {
		if (!this.open) return Promise.reject(unavailable(`link to ${this.name ?? "peer"} closed`));
		return this.synced
			? Promise.resolve()
			: new Promise<void>((resolve, reject) => this.#sync.add({ resolve: () => resolve(), reject }));
	}
	markSynced(version: number): void {
		this.peerCodeVersion = version;
		this.synced = true;
		for (const pending of this.#sync) pending.resolve(undefined);
		this.#sync.clear();
	}
	revoke(next: unknown | undefined): void {
		this.generation++;
		const error = new ChordError("gone", "principal invalidated");
		for (const served of [...this.served.values()])
			if (served.kind === "relay") served.relay.close(error, { releaseDown: true, notify: true });
		if (next === undefined) this.link.close("principal invalidated");
		else this.principal = next;
	}
	#protocolMismatch(peer: number | undefined, close = true): void {
		if (this.#mismatched) return;
		this.#mismatched = true;
		try {
			this.#mismatch?.({ local: PROTOCOL_VERSION, peer });
		} catch (error) {
			this.host.report(error);
		}
		if (close) this.link.close(`protocol-version ${PROTOCOL_VERSION}`);
	}
	#violation(reason: string): void {
		this.host.report(new ChordError("invalid", `link to ${this.name ?? "peer"}: ${reason}`, { reason: "protocol" }));
		this.link.close(`protocol error: ${reason}`);
	}
	hold(binding: RemoteBinding, again: boolean): number {
		const id = this.nextId();
		this.remotes.set(id, binding);
		binding.bound(this, id);
		this.send({
			t: "hold",
			id,
			at: binding.at,
			token: binding.contract.description,
			input: binding.input,
			...(binding.principal === undefined ? {} : { principal: binding.principal }),
			...(binding.stateOn ? {} : { state: false as const }),
			...(again ? { again: true as const } : {}),
		});
		return id;
	}
	release(id: number): void {
		this.remotes.delete(id);
		this.send({ t: "release", id });
	}
	wantState(hold: number, wanted: boolean): void {
		if (this.remotes.has(hold)) this.send({ t: wanted ? "sub" : "unsub", hold });
	}
	call(hold: number, member: string, args: unknown, root: RootRef | undefined, signal: AbortSignal): Promise<unknown> {
		const id = this.nextId();
		return new Promise((resolve, reject) => {
			if (signal.aborted) {
				reject(new ChordError("aborted", "call aborted"));
				return;
			}
			const abort = (): void => {
				this.calls.delete(id);
				this.send({ t: "cancel", id });
				reject(new ChordError("aborted", "call aborted", { cause: signal.reason }));
			};
			signal.addEventListener("abort", abort, { once: true });
			this.calls.set(id, {
				resolve(value) {
					signal.removeEventListener("abort", abort);
					resolve(value);
				},
				reject(error) {
					signal.removeEventListener("abort", abort);
					reject(error);
				},
			});
			const carried = root !== undefined && this.host.kind === "host";
			if (carried) this.host.rootSent(root.rootId, this);
			this.send({ t: "call", id, hold, member, args, ...(carried ? { root } : {}) });
		});
	}
	#receive(frame: unknown): void {
		if (this.#mismatched) return;
		this.#seen = Date.now();
		if (!isFrame(frame)) {
			this.#violation("malformed frame");
			return;
		}
		if (frame.t === "ack") {
			this.#onAck(frame.n);
			return;
		}
		this.#received++;
		try {
			this.#dispatch(frame);
		} catch (error) {
			this.host.report(error);
		}
		this.#scheduleAck();
	}
	#dispatch(frame: Frame): void {
		switch (frame.t) {
			case "hello":
				this.#hello(frame);
				return;
			case "ping":
				this.send({ t: "pong", n: frame.n });
				return;
			case "pong":
			case "bye":
			case "ack":
				return;
			case "hold":
				this.#hold(frame);
				return;
			case "release":
				this.#dropServed(frame.id, true);
				return;
			case "call":
				this.#call(frame);
				return;
			case "cancel":
				this.incoming.get(frame.id)?.abort(new ChordError("aborted", "cancelled by caller"));
				return;
			case "sub":
			case "unsub":
				this.#wantState(frame.hold, frame.t === "sub");
				return;
			case "resync":
				this.#resync(frame.hold, frame.m);
				return;
			case "shape":
			case "gone":
				this.#holdReply(frame);
				return;
			case "result":
				this.#result(frame);
				return;
			case "state":
				this.#state(frame);
				return;
			case "root_end":
				this.#admitted.delete(frame.rootId);
				this.host.foreignRootEnded(frame.rootId, this);
				return;
			case "invalidate":
			case "prepare":
			case "commit":
			case "abort":
			case "retire":
				if (this.role !== "upstream") {
					this.#violation(`${frame.t} from a child`);
					return;
				}
				if (frame.t === "invalidate")
					void this.host.invalidatePrincipal(frame.pattern).catch((error) => this.host.report(error));
				else if (frame.t === "retire") this.host.allowRetire(frame.codeVersion);
				else this.host.onReloadFrame(this, frame);
				return;
			case "vote": {
				if (this.role !== "downstream" || this.peer.kind !== "host") {
					this.#violation("vote from a non-participant");
					return;
				}
				const pending = this.votes.get(frame.reload);
				this.votes.delete(frame.reload);
				if (frame.error === undefined) pending?.resolve(frame.report);
				else pending?.reject(fromWireError(frame.error));
				return;
			}
		}
	}
	#hello(frame: Extract<Frame, { t: "hello" }>): void {
		if ((frame.protocol ?? 1) !== PROTOCOL_VERSION) {
			this.#protocolMismatch(frame.protocol ?? 1);
			return;
		}
		if (this.#peerAcks === undefined) {
			this.#peerAcks = frame.acks === true;
			if (!this.#peerAcks) {
				this.#unacked = [];
				this.#bytes = 0;
			}
		}
		if (this.role === "upstream") {
			if (frame.kind !== "host") this.#violation("parent is not a host");
			else this.#parentName ??= frame.name;
			return;
		}
		if (frame.kind !== this.peer.kind || (this.peer.name !== undefined && frame.name !== this.peer.name)) {
			this.#violation(
				`hello ${frame.kind} ${frame.name} does not match the accepted ${this.peer.kind} ${this.peer.name ?? ""}`,
			);
			return;
		}
		if (this.peer.kind === "host") this.host.peerHello(this, frame.codeVersion);
	}
	#hold(frame: Extract<Frame, { t: "hold" }>): void {
		if (this.served.has(frame.id)) {
			this.#violation(`duplicate hold id ${frame.id}`);
			return;
		}
		const principal = this.role === "downstream" ? this.principal : (frame.principal ?? this.principal);
		const origin = this.role === "downstream" ? this.originId : frame.origin;
		if (frame.at !== this.host.name) {
			if (this.role === "upstream") {
				this.send({ t: "gone", id: frame.id, error: toWireError(unavailable(`${this.host.name} does not relay`)) });
				return;
			}
			const relay = new RelayRef(this, frame, principal, origin);
			this.served.set(frame.id, { kind: "relay", relay });
			void this.host.relay(relay).catch((error) => relay.close(error, { releaseDown: true, notify: true }));
			return;
		}
		let ref: RefImpl;
		try {
			const token = contractFromDescription(frame.token);
			if (token.scope !== "remote") throw invalid("token", `${token.name} is local; only remote types cross links`);
			if (resolveHost(token.name, token.description.host!, frame.input) !== this.host.name)
				throw invalid("placement", `${token.name} with this input does not live on ${this.host.name}`);
			const acquired = this.host.acquire(
				token,
				frame.input,
				{ principal },
				origin === undefined ? "connection" : "client",
			);
			if (!(acquired instanceof RefImpl)) throw unavailable("not a local reference");
			ref = acquired;
		} catch (error) {
			this.send({ t: "gone", id: frame.id, error: toWireError(origin === undefined ? error : clientError(error)) });
			return;
		}
		const served: ServedLocal = {
			kind: "local",
			id: frame.id,
			ref,
			principal,
			origin,
			wantsState: frame.state !== false,
			again: frame.again === true,
			unitSent: false,
			feeds: new Map(),
		};
		this.served.set(frame.id, served);
		ref.onShape(() => this.#unit(served));
		ref.goneListeners.add((error) => {
			if (this.served.get(frame.id) === served) {
				this.#dropServed(frame.id, false);
				this.send({ t: "gone", id: frame.id, error: toWireError(error) });
			}
		});
		if (ref.status === "live") this.#unit(served);
	}
	#members(ref: RefImpl, shape: Shape): string[] {
		return shape.members.filter((name) => ref.describe(shape.variant, name)?.kind === "state");
	}
	#unit(served: ServedLocal): void {
		if (this.served.get(served.id) !== served) return;
		const shape = served.ref.shape;
		if (!shape) return;
		const wanted = new Set(served.wantsState ? this.#members(served.ref, shape) : []);
		for (const [name, feed] of served.feeds)
			if (!wanted.has(name)) {
				feed.unsubscribe();
				served.feeds.delete(name);
				this.dropState(served.id, name);
			}
		if (!served.feeds.size && !(served.again && !served.unitSent)) this.#sendUnit(served);
		else this.#queueUnit(served.id, () => this.#sendUnit(served));
	}
	#sendUnit(served: ServedLocal): void {
		this.#pending.delete(unitKey(served.id));
		if (this.served.get(served.id) !== served) return;
		const shape = served.ref.shape;
		if (!shape) return;
		served.unitSent = true;
		const names = served.wantsState ? this.#members(served.ref, shape).filter((name) => !served.feeds.has(name)) : [];
		const snapshots: StateFrame[] = [];
		const attached: [string, Feed][] = [];
		for (const name of names) {
			const entry = this.#attach(served, name);
			if (!entry) continue;
			snapshots.push(entry.frame);
			attached.push([name, entry.feed]);
		}
		this.send({
			t: "shape",
			id: served.id,
			...(shape.variant === undefined ? {} : { variant: shape.variant }),
			members: shape.members,
			contract: shape.contract,
			state: snapshots.map((frame) => frame.m),
		});
		for (const frame of snapshots) this.send(frame);
		for (const [name, feed] of attached) this.#replay(served, name, feed);
	}
	#attach(
		served: ServedLocal,
		name: string,
		as: "snap" | "reset" = "snap",
	): { frame: StateFrame; feed: Feed } | undefined {
		const readable = served.ref.member(name) as Readable<unknown> | undefined;
		if (!readable || typeof readable.events !== "function") return undefined;
		const feed: Feed = { unsubscribe() {}, encoder: encoder(), buffer: [] };
		let first: StateEvent<unknown> | undefined;
		feed.unsubscribe = readable.events((event) => {
			if (!first) first = event;
			else if (feed.buffer) feed.buffer.push(event);
			else this.#feedEvent(served, name, feed, event);
		});
		served.feeds.set(name, feed);
		return { frame: this.#snapshot(served, name, as, first?.value), feed };
	}
	#replay(served: ServedLocal, name: string, feed: Feed): void {
		const buffered = feed.buffer ?? [];
		feed.buffer = undefined;
		for (const event of buffered) this.#feedEvent(served, name, feed, event);
	}
	#snapshot(served: ServedLocal, name: string, as: "snap" | "reset", value: unknown): StateFrame {
		try {
			validateSnapshot(served.ref, name, value);
		} catch (error) {
			return { t: "state", hold: served.id, m: name, as: "error", error: toWireError(error) };
		}
		return { t: "state", hold: served.id, m: name, as, ...(value === undefined ? {} : { value }) };
	}
	#feedEvent(served: ServedLocal, name: string, feed: Feed, event: StateEvent<unknown>): void {
		if (served.feeds.get(name) !== feed) return;
		const overflow = { resend: () => this.#resend(served, name) };
		if (event.type === "ops")
			this.sendState(
				{ t: "state", hold: served.id, m: name, as: "ops", ops: feed.encoder.encode(event.ops) },
				overflow,
			);
		else {
			feed.encoder = encoder();
			this.sendState(this.#snapshot(served, name, "reset", event.value), overflow);
		}
	}
	#resend(served: ServedLocal, name: string): void {
		const feed = served.feeds.get(name);
		if (!feed || this.served.get(served.id) !== served) return;
		feed.unsubscribe();
		served.feeds.delete(name);
		const attachment = this.#attach(served, name, "reset");
		if (attachment) {
			this.send(attachment.frame);
			this.#replay(served, name, attachment.feed);
		}
	}
	#wantState(hold: number, wanted: boolean): void {
		const served = this.served.get(hold);
		if (!served) return;
		if (served.kind === "relay") {
			served.relay.wantState(wanted);
			return;
		}
		if (served.wantsState === wanted) return;
		served.wantsState = wanted;
		if (wanted) this.#unit(served);
		else {
			for (const feed of served.feeds.values()) feed.unsubscribe();
			served.feeds.clear();
			this.dropHoldState(hold);
		}
	}
	#resync(hold: number, member: string): void {
		const served = this.served.get(hold);
		if (!served) return;
		if (served.kind === "relay") served.relay.resync(member);
		else if (served.feeds.has(member)) this.#resetLater(hold, member, () => this.#resend(served, member));
	}
	#dropServed(id: number, release: boolean): void {
		const served = this.served.get(id);
		if (!served) return;
		this.served.delete(id);
		if (served.kind === "relay") {
			served.relay.close(new ChordError("released", "relayed hold released"), { releaseDown: release, notify: false });
			return;
		}
		for (const feed of served.feeds.values()) feed.unsubscribe();
		served.feeds.clear();
		this.dropHoldState(id);
		if (release) served.ref.release();
	}
	#call(frame: Extract<Frame, { t: "call" }>): void {
		if (this.incoming.has(frame.id)) {
			this.#violation(`duplicate call id ${frame.id}`);
			return;
		}
		if (this.incoming.size >= this.#maxCalls) {
			const error = new ChordError(
				"unavailable",
				`Too many calls in progress on this connection (${this.#maxCalls}); wait for earlier ones to finish`,
				{ reason: "too_many_calls" },
			);
			this.send({ t: "result", id: frame.id, error: toWireError(error) });
			return;
		}
		const served = this.served.get(frame.hold);
		if (!served) {
			this.send({ t: "result", id: frame.id, error: toWireError(new ChordError("gone", "unknown hold")) });
			return;
		}
		const controller = new AbortController();
		this.incoming.set(frame.id, controller);
		const root = this.peer.kind === "host" ? this.#admitRoot(frame.root) : undefined;
		const options = {
			principal: served.kind === "local" ? served.principal : served.relay.principal,
			signal: controller.signal,
		};
		const run =
			served.kind === "local"
				? (ctx: Ctx) => served.ref.object.call(served.ref, frame.member, unpack(frame.args), ctx as CtxImpl)
				: (ctx: Ctx) =>
						relayCall(served.relay, frame, { rootId: ctx.rootId, codeVersion: ctx.codeVersion }, ctx.signal, this.host);
		const result = root
			? this.host.joinRoot(root.rootId, root.codeVersion, run, { ...options, from: this })
			: this.host.root(run, options);
		void result
			.then(
				(value) => this.send({ t: "result", id: frame.id, value }),
				(error) => this.send({ t: "result", id: frame.id, error: toWireError(error) }),
			)
			.finally(() => this.incoming.delete(frame.id));
	}
	#admitRoot(root: RootRef | undefined): RootRef | undefined {
		if (
			!root ||
			this.role !== "downstream" ||
			!this.fencedCodeVersions.has(root.codeVersion) ||
			this.host.hasCodeVersion(root.codeVersion)
		)
			return root;
		let version = this.#admitted.get(root.rootId);
		if (version === undefined) {
			version = this.host.current.id;
			this.#admitted.set(root.rootId, version);
		}
		return { rootId: root.rootId, codeVersion: version };
	}
	#holdReply(frame: Extract<Frame, { t: "shape" | "gone" }>): void {
		const relay = this.relayedRefs.get(frame.id);
		if (relay) {
			if (frame.t === "gone") relay.close(fromWireError(frame.error), { releaseDown: false, notify: true });
			else relay.shape(frame);
			return;
		}
		const binding = this.remotes.get(frame.id);
		if (!binding) return;
		if (frame.t === "gone") {
			this.remotes.delete(frame.id);
			binding.gone(fromWireError(frame.error));
		} else binding.shaped({ variant: frame.variant, members: frame.members, contract: frame.contract }, frame.state);
	}
	#result(frame: Extract<Frame, { t: "result" }>): void {
		const relayed = this.relayedCalls.get(frame.id);
		if (relayed) {
			relayed.finish(frame.error === undefined ? undefined : fromWireError(frame.error), frame.value);
			return;
		}
		const pending = this.calls.get(frame.id);
		this.calls.delete(frame.id);
		if (frame.error) {
			pending?.reject(fromWireError(frame.error));
			return;
		}
		let value: unknown;
		try {
			value = unpack(frame.value);
		} catch (error) {
			pending?.reject(error);
			return;
		}
		pending?.resolve(value);
	}
	#state(frame: StateFrame): void {
		const relay = this.relayedRefs.get(frame.hold);
		if (relay) {
			relay.state(frame);
			return;
		}
		const binding = this.remotes.get(frame.hold);
		if (!binding) return;
		if (!(frame.value instanceof Packed)) {
			binding.state(frame.m, frame);
			return;
		}
		let value: unknown;
		try {
			value = unpack(frame.value);
		} catch (error) {
			binding.state(frame.m, { as: "error", error: toWireError(error) });
			return;
		}
		binding.state(frame.m, { ...frame, value });
	}
	#closed(reason: string): void {
		const mismatch = /^protocol-version (\d+)$/.exec(reason);
		if (mismatch && Number(mismatch[1]) !== PROTOCOL_VERSION) this.#protocolMismatch(Number(mismatch[1]), false);
		clearInterval(this.#pinger);
		clearTimeout(this.#ackTimer);
		this.#pending.clear();
		this.#waitingBytes = 0;
		const error = unavailable(`link to ${this.name ?? "peer"} closed: ${reason}`);
		for (const id of [...this.served.keys()]) this.#dropServed(id, true);
		for (const controller of this.incoming.values()) controller.abort(error);
		this.incoming.clear();
		for (const map of [this.calls, this.votes]) {
			for (const pending of map.values()) pending.reject(error);
			map.clear();
		}
		for (const pending of this.#sync) pending.reject(error);
		this.#sync.clear();
		for (const relay of [...this.relayedRefs.values()]) relay.close(error, { releaseDown: false, notify: true });
		this.relayedRefs.clear();
		this.relayedCalls.clear();
		const bindings = [...this.remotes.values()];
		this.remotes.clear();
		for (const binding of bindings)
			if (this.role === "upstream") binding.detached();
			else binding.gone(error);
		this.host.connectionClosed(this);
	}
}

async function relayCall(
	relay: RelayRef,
	frame: Extract<Frame, { t: "call" }>,
	root: RootRef,
	signal: AbortSignal,
	host: HostImpl,
): Promise<unknown> {
	const error = (): ChordError => new ChordError("aborted", "call cancelled", { cause: signal.reason });
	if (signal.aborted) throw error();
	let abort = (): void => {},
		cancel = (): void => {};
	const aborted = new Promise<never>((_, reject) => {
		abort = () => reject(error());
		signal.addEventListener("abort", abort, { once: true });
	});
	aborted.catch(() => {});
	try {
		const down = await Promise.race([relay.ready(), aborted]);
		if (relay.closed) throw new ChordError("gone", "relayed hold closed");
		return await new Promise((resolve, reject) => {
			const call = new RelayCall(relay, frame.id, down.nextId(), { resolve, reject });
			cancel = () => call.cancel(error(), true);
			signal.addEventListener("abort", cancel, { once: true });
			host.rootSent(root.rootId, down);
			down.send({ t: "call", id: call.downId, hold: relay.downId, member: frame.member, args: frame.args, root });
		});
	} finally {
		signal.removeEventListener("abort", abort);
		signal.removeEventListener("abort", cancel);
	}
}
function validateSnapshot(ref: RefImpl, name: string, value: unknown): void {
	if (value === undefined) return;
	const installed = ref.object.currentInstalled();
	if (!installed) return;
	const view = ref.currentView(),
		variant = view ? variantOf(view) : variantOf(installed.implementation);
	const description =
		view && view !== installed.implementation
			? ref.contract.description.variants[variant ?? LOCAL_VARIANT]?.[name]
			: installed.service.contract.description.variants[variantOf(installed.implementation) ?? LOCAL_VARIANT]?.[name];
	if (description?.kind === "state") assertValid("state", `${ref.address}.${name}`, description.schema, value);
}
function clientError(error: unknown): unknown {
	return error instanceof ChordError && error.code === "contract_mismatch"
		? new ChordError("upgrade_required", error.message, { cause: error })
		: error;
}
