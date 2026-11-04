import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal, type Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Address, HostKind, KindShape } from "../../contracts/index.ts";
import type { Params } from "../../contracts/internal.ts";
import { ObjectsError, type Principal } from "../../data/index.ts";
import type { Host, RouteHandle, RouteOptions } from "../../host/index.ts";
import { Batch, Source, type BatchError } from "../../state/internal.ts";
import type { Watchable } from "../../watch.ts";
import type { Plugins, RolloutHost, RolloutStep } from "../plugins/plugins.ts";
import type { PluginScript } from "../plugins/runtime.ts";
import { uncrossed, uncrossedReport, type CrossedError, type CrossedReport, type FromWorker } from "./control.ts";
import { clearStaleLock } from "./lock.ts";
import { WorkerProcess, type Exit } from "./process.ts";
export type WorkersOptions<P extends Principal, K extends KindShape> = {
	readonly kind: string;
	readonly entry: string;
	readonly execArgv?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly authorize: (principal: P, address: Address<K>) => boolean;
	readonly principal: (address: Address<K>) => P;
	readonly start: (address: Address<K>, context: Context) => Promise<JsonValue> | JsonValue;
	readonly lock: (address: Address<K>) => string;
	readonly idleMs?: () => number;
	readonly plugins: Plugins;
	readonly onOutput?: (address: Address<K>, stream: "stdout" | "stderr", chunk: Uint8Array) => void;
	readonly onError: (error: WorkersError) => void;
};
export type WorkerState =
	| { readonly status: "starting" | "running" | "stopping"; readonly pid: number; readonly startedAt: number }
	| { readonly status: "failed"; readonly error: CrossedError; readonly at: number };
export type WorkersError =
	| { readonly kind: "worker_failed"; readonly address: string; readonly error: unknown; readonly stderrTail?: string }
	| { readonly kind: "worker_link_lost"; readonly address: string; readonly error: unknown }
	| { readonly kind: "authorize_failed"; readonly address: string; readonly error: unknown }
	| {
			readonly kind: "worker_exited";
			readonly address: string;
			readonly code: number | null;
			readonly signal: string | null;
	  }
	| BatchError;
export interface Workers<K extends KindShape> {
	readonly state: Watchable<Readonly<Record<string, WorkerState>>>;
	stop(address: Address<K>, context: Context): Promise<void>;
	retry(address: Address<K>, context: Context): Promise<void>;
	step(name: string): RolloutStep;
	close(context: Context): Promise<void>;
}
export function createWorkers<P extends Principal, N extends string, Q extends Params>(
	host: Host<P>,
	kind: HostKind<N, Q>,
	options: WorkersOptions<P, HostKind<N, Q>>,
	context: Context,
): Workers<HostKind<N, Q>> {
	return new WorkerPool(options, context, (route) => host.route(kind, route, context));
}
type Failure = { error: CrossedError; at: number };
type Cause = { error: unknown; public?: CrossedError; killed?: true; lost?: true };
type Ended = { kind: "stopped" } | { kind: "failed"; error: unknown };
type ReloadReply = Extract<FromWorker, { kind: "reloaded" }>;
type Child = {
	process: WorkerProcess;
	status: "starting" | "running" | "stopping";
	stopping: boolean;
	cause: Cause | undefined;
	started: PromiseWithResolvers<void>;
	ready: PromiseWithResolvers<CrossedReport>;
	idleSince: number | undefined;
	idleStop: boolean;
	shipped: string;
	reloading: Promise<void>;
	reply: ((message: ReloadReply) => void) | undefined;
	ended: Ended | undefined;
	grace: ReturnType<typeof setTimeout> | undefined;
	lock: string | undefined;
};
type Slot<K extends KindShape> = {
	address: Address<K>;
	queue: Promise<void>;
	pending: number;
	child: Child | undefined;
	failure: Failure | undefined;
	starting: Promise<unknown> | undefined;
	recovered: number | undefined;
};
const startFailed: CrossedError = { message: "worker failed to start", code: "unavailable" };
function lostLink(child: Child): Cause {
	const error = new Error("worker: link lost");
	return child.status === "running" ? { error, public: { message: "worker lost its link", code: "unavailable" }, lost: true } : { error };
}
const closed = (): ObjectsError => new ObjectsError({ code: "released", reason: "closed", message: "workers: closed" });
const scriptKey = (scripts: readonly PluginScript[]): string =>
	scripts
		.map(({ plugin, built }) => `${plugin.name}@${built.kind === "script" ? built.digest : "failed"}`)
		.sort()
		.join("\n");
class WorkerPool<P extends Principal, K extends KindShape> implements Workers<K> {
	readonly state: Watchable<Readonly<Record<string, WorkerState>>>;
	readonly #options: WorkersOptions<P, K>;
	readonly #slots = new Map<string, Slot<K>>();
	readonly #view: WorkerView;
	readonly #closing = new AbortController();
	readonly #closingContext = withAbortSignal(this.#closing.signal, BACKGROUND_CONTEXT);
	readonly #route: RouteHandle<K>;
	#routing = false;
	#idle: ReturnType<typeof setInterval> | undefined;
	constructor(options: WorkersOptions<P, K>, context: Context, route: (options: RouteOptions<P, K>) => RouteHandle<K>) {
		this.#options = options;
		this.#view = new WorkerView(() => this.#snapshot(), new Batch((error) => options.onError(error), undefined));
		this.state = this.#view as unknown as Watchable<Readonly<Record<string, WorkerState>>>;
		this.#route = route({
			authorize: (principal, address) => {
				try {
					return options.authorize(principal, address);
				} catch (error) {
					options.onError({ kind: "authorize_failed", address: address.key, error });
					return false;
				}
			},
			resolve: (address, routing) => this.#resolve(address, routing),
		});
		this.#followClose(context);
	}
	#followClose(context: Context): void {
		if (context.abortSignal && !context.abortSignal.aborted)
			context.abortSignal.addEventListener(
				"abort",
				() => {
					void this.close(BACKGROUND_CONTEXT).catch(() => {});
				},
				{ once: true },
			);
	}
	#slot(address: Address<K>): Slot<K> {
		let slot = this.#slots.get(address.key);
		if (!slot) {
			slot = {
				address,
				queue: Promise.resolve(),
				pending: 0,
				child: undefined,
				failure: undefined,
				starting: undefined,
				recovered: undefined,
			};
			this.#slots.set(address.key, slot);
		}
		return slot;
	}
	#forget(slot: Slot<K>): void {
		if (!slot.pending && !slot.child && !slot.failure) this.#slots.delete(slot.address.key);
	}
	#queue<T>(slot: Slot<K>, operation: () => Promise<T>): Promise<T> {
		slot.pending++;
		const run = slot.queue.then(operation),
			done = (): void => {
				slot.pending--;
				this.#forget(slot);
			};
		slot.queue = run.then(done, done);
		return run;
	}
	#resolve(
		address: Address<K>,
		routing: Context,
	): Promise<{ link: WorkerProcess["link"]; principal: P; trusted: true }> {
		if (!this.#routing) {
			this.#routing = true;
			this.#followClose(routing);
		}
		const slot = this.#slot(address);
		if (slot.failure) return Promise.reject(uncrossed(slot.failure.error));
		if (this.#closing.signal.aborted) return Promise.reject(closed());
		const run = this.#queue(slot, () => this.#start(slot, routing));
		slot.starting = run;
		const done = (): void => {
			if (slot.starting === run) slot.starting = undefined;
		};
		run.then(done, done);
		return run;
	}
	async stop(address: Address<K>, context: Context): Promise<void> {
		this.#route.suspend(address);
		const slot = this.#slots.get(address.key);
		if (slot)
			await awaitWithContext(
				this.#queue(slot, () => this.#stop(slot)),
				context,
			);
	}
	async retry(address: Address<K>, _context: Context): Promise<void> {
		const slot = this.#slots.get(address.key);
		if (slot) {
			slot.failure = undefined;
			this.#view.refresh();
			this.#forget(slot);
		}
		this.#route.retry(address);
	}
	step(name: string): RolloutStep {
		return { name, kinds: [this.#options.kind], reload: (_built, context) => this.#rollout(context) };
	}
	async close(context: Context): Promise<void> {
		if (!this.#closing.signal.aborted) this.#closing.abort(closed());
		clearInterval(this.#idle);
		this.#idle = undefined;
		await awaitWithContext(
			Promise.all([...this.#slots.values()].map((slot) => this.#queue(slot, () => this.#stop(slot)))),
			context,
		);
	}
	async #start(slot: Slot<K>, routing: Context): Promise<{ link: WorkerProcess["link"]; principal: P; trusted: true }> {
		await slot.child?.process.exited;
		const previousFailure = slot.failure;
		if (previousFailure) throw uncrossed(previousFailure.error);
		if (this.#closing.signal.aborted) throw closed();
		const context = withAbortSignal(this.#closing.signal, routing);
		let data: JsonValue;
		try {
			data = await awaitWithContext(Promise.resolve(this.#options.start(slot.address, context)), this.#closingContext);
		} catch (error) {
			if (this.#closing.signal.aborted) throw closed();
			throw this.#fail(slot, { error, public: startFailed }, undefined);
		}
		if (this.#closing.signal.aborted) throw closed();
		let child: Child;
		try {
			child = this.#fork(slot);
		} catch (error) {
			throw this.#fail(slot, { error, public: startFailed }, undefined);
		}
		const timeout = setTimeout(() => {
			child.cause ??= { error: new Error(`worker ${slot.address.key}: did not start within 60 s`), killed: true };
			child.process.kill();
		}, 60000);
		try {
			const scripts = await this.#options.plugins.scripts(this.#options.kind, context);
			child.shipped = scriptKey(scripts);
			const lock = this.#options.lock(slot.address);
			child.lock = lock;
			await clearStaleLock(lock, context);
			child.process.send({ kind: "start", address: slot.address, start: data, scripts, lock });
			await awaitWithContext(child.started.promise, this.#closingContext);
			return { link: child.process.link, principal: this.#options.principal(slot.address), trusted: true };
		} catch (error) {
			if (this.#closing.signal.aborted) child.stopping = true;
			else child.cause ??= { error, public: startFailed, killed: true };
			child.process.kill();
			await child.process.exited;
			if (this.#closing.signal.aborted) throw closed();
			throw uncrossed(slot.failure?.error ?? startFailed);
		} finally {
			clearTimeout(timeout);
		}
	}
	#fork(slot: Slot<K>): Child {
		let child: Child;
		const options = this.#options;
		const onOutput = options.onOutput;
		const process = new WorkerProcess(
			{
				entry: options.entry,
				...(options.execArgv === undefined ? {} : { execArgv: options.execArgv }),
				...(options.env === undefined ? {} : { env: options.env }),
				...(onOutput === undefined ? {} : { onOutput: (stream, chunk) => onOutput(slot.address, stream, chunk) }),
			},
			{
				control: (message) => this.#message(slot, child, message),
				linkLost: () => this.#lost(child),
				linkClosed: () => this.#disconnected(child),
				exited: (exit) => this.#exited(slot, child, exit),
			},
		);
		child = {
			process,
			status: "starting",
			stopping: false,
			cause: undefined,
			started: Promise.withResolvers(),
			ready: Promise.withResolvers(),
			idleSince: undefined,
			idleStop: false,
			shipped: "",
			reloading: Promise.resolve(),
			reply: undefined,
			ended: undefined,
			grace: undefined,
			lock: undefined,
		};
		child.started.promise.catch(() => {});
		child.ready.promise.catch(() => {});
		slot.child = child;
		this.#view.refresh();
		this.#watchIdle();
		return child;
	}
	#message(slot: Slot<K>, child: Child, message: FromWorker): void {
		switch (message.kind) {
			case "started":
				child.started.resolve();
				break;
			case "ready":
				child.status = "running";
				child.idleSince = message.idle ? Date.now() : undefined;
				child.ready.resolve(message.report);
				if (slot.child === child) this.#view.refresh();
				break;
			case "idle":
				child.idleSince = message.idle ? (child.idleSince ?? Date.now()) : undefined;
				break;
			case "fatal":
				child.cause ??= { error: uncrossed(message.error), public: message.error };
				child.started.reject(uncrossed(message.error));
				child.process.kill();
				break;
			case "reloaded":
				child.reply?.(message);
				break;
		}
	}
	#ended(child: Child): void {
		if (child.ended) return;
		child.ended =
			child.stopping && !child.cause
				? { kind: "stopped" }
				: { kind: "failed", error: new ObjectsError({ code: "unavailable", message: "worker: its link is gone" }) };
		child.reply?.({ kind: "reloaded", error: { message: "worker: its link is gone" } });
	}
	#lost(child: Child): void {
		this.#ended(child);
		if (child.stopping) return;
		child.cause ??= lostLink(child);
		this.#shutdown(child);
		this.#view.refresh();
	}
	#disconnected(child: Child): void {
		this.#ended(child);
		if (child.stopping || child.grace) return;
		const cause = lostLink(child);
		child.grace = setTimeout(() => {
			child.cause ??= cause;
			child.process.kill();
		}, 5000);
	}
	#exited(slot: Slot<K>, child: Child, exit: Exit): void {
		clearTimeout(child.grace);
		const clean = child.stopping && !child.cause;
		const cause = child.cause ?? {
			error: new ObjectsError({
				code: "unavailable",
				message: `worker ${slot.address.key}: ${child.status === "starting" ? "exited before it was ready" : "exited"} (${exit.signal === null ? `code ${exit.code}` : `signal ${exit.signal}`})`,
			}),
		};
		const error =
			cause.public ??
			(child.status === "starting"
				? startFailed
				: { message: `worker exited (${exit.signal ?? `code ${exit.code}`})`, code: "unavailable" });
		child.started.reject(uncrossed(error));
		child.ready.reject(uncrossed(error));
		this.#ended(child);
		if (child.lock !== undefined && exit.signal !== null) {
			const lock = child.lock;
			void this.#queue(slot, () => clearStaleLock(lock, BACKGROUND_CONTEXT)).catch(() => {});
		}
		if (slot.child !== child) return;
		slot.child = undefined;
		if (!clean && !this.#closing.signal.aborted) {
			const now = Date.now();
			if (cause.lost && (slot.recovered === undefined || now - slot.recovered >= 60000)) {
				slot.recovered = now;
				this.#options.onError({ kind: "worker_link_lost", address: slot.address.key, error: cause.error });
			} else {
				if (!cause.killed)
					this.#options.onError({
						kind: "worker_exited",
						address: slot.address.key,
						code: exit.code,
						signal: exit.signal,
					});
				this.#fail(slot, { ...cause, public: error }, child.process.stderrTail);
			}
		}
		this.#view.refresh();
		this.#forget(slot);
	}
	#fail(slot: Slot<K>, cause: Cause & { public: CrossedError }, stderrTail: string | undefined): Error {
		slot.failure = { error: cause.public, at: Date.now() };
		this.#options.onError({
			kind: "worker_failed",
			address: slot.address.key,
			error: cause.error,
			...(stderrTail === undefined ? {} : { stderrTail }),
		});
		this.#view.refresh();
		return uncrossed(cause.public);
	}
	#shutdown(child: Child): void {
		child.status = "stopping";
		child.process.send({ kind: "shutdown" });
		clearTimeout(child.grace);
		child.grace = setTimeout(() => child.process.kill(), 5000);
	}
	async #stop(slot: Slot<K>): Promise<void> {
		const child = slot.child;
		if (!child) return;
		child.stopping = true;
		this.#shutdown(child);
		this.#view.refresh();
		await child.process.exited;
	}
	#watchIdle(): void {
		if (this.#idle) return;
		this.#idle = setInterval(() => this.#checkIdle(), 1000);
		this.#idle.unref();
	}
	#checkIdle(): void {
		const idleMs = this.#options.idleMs?.() ?? 300000,
			now = Date.now();
		let count = 0;
		for (const slot of this.#slots.values()) {
			const child = slot.child;
			if (!child) continue;
			count++;
			if (
				child.idleStop ||
				child.status !== "running" ||
				child.idleSince === undefined ||
				now - child.idleSince < idleMs
			)
				continue;
			child.idleStop = true;
			void this.#queue(slot, async () => {
				child.idleStop = false;
				if (
					slot.child === child &&
					child.idleSince !== undefined &&
					Date.now() - child.idleSince >= (this.#options.idleMs?.() ?? 300000)
				)
					await this.#stop(slot);
			});
		}
		if (!count) {
			clearInterval(this.#idle);
			this.#idle = undefined;
		}
	}
	async #rollout(context: Context): Promise<{ readonly hosts: readonly RolloutHost[] }> {
		const { kind, plugins } = this.#options,
			scripts = plugins.current(kind) ?? (await plugins.scripts(kind, context)),
			key = scriptKey(scripts);
		const entries: { host: string; run: Promise<RolloutHost> }[] = [];
		for (const slot of [...this.#slots.values()]) {
			if (!slot.failure) continue;
			slot.failure = undefined;
			this.#view.refresh();
			this.#route.retry(slot.address);
			const starting = slot.starting;
			if (!starting) this.#forget(slot);
			else entries.push({ host: slot.address.key, run: this.#retried(slot, starting) });
		}
		for (const slot of this.#slots.values()) {
			const child = slot.child;
			if (!child || child.status === "stopping" || child.shipped === key) continue;
			entries.push({ host: slot.address.key, run: this.#reload(slot.address.key, child, scripts, key) });
		}
		return {
			hosts: await Promise.all(
				entries.map(async ({ host, run }) => {
					try {
						return await awaitWithContext(run, context);
					} catch (error) {
						return { host, error };
					}
				}),
			),
		};
	}
	async #retried(slot: Slot<K>, starting: Promise<unknown>): Promise<RolloutHost> {
		const host = slot.address.key;
		try {
			await starting;
			const child = slot.child;
			if (!child) throw new Error("worker: exited");
			return { host, report: uncrossedReport(await child.ready.promise) };
		} catch (error) {
			return { host, error };
		}
	}
	#reload(host: string, child: Child, scripts: readonly PluginScript[], key: string): Promise<RolloutHost> {
		const run = child.reloading.then(
			() =>
				new Promise<RolloutHost>((resolve) => {
					const ended = (state: Ended): void =>
						resolve(state.kind === "stopped" ? { host, stopped: true } : { host, error: state.error });
					if (child.ended) {
						ended(child.ended);
						return;
					}
					child.reply = (reply) => {
						child.reply = undefined;
						if ("report" in reply) {
							if (!reply.report.failed.length) child.shipped = key;
							resolve({ host, report: uncrossedReport(reply.report) });
						} else if (child.ended) ended(child.ended);
						else resolve({ host, error: uncrossed(reply.error) });
					};
					child.process.send({ kind: "reload", scripts });
				}),
		);
		child.reloading = run.then(
			() => {},
			() => {},
		);
		return run;
	}
	#snapshot(): Record<string, WorkerState> {
		const result: Record<string, WorkerState> = {};
		for (const [key, slot] of this.#slots) {
			if (slot.failure) result[key] = { status: "failed", ...slot.failure };
			else if (slot.child)
				result[key] = {
					status: slot.child.status,
					pid: slot.child.process.pid,
					startedAt: slot.child.process.startedAt,
				};
		}
		return result;
	}
}
class WorkerView extends Source {
	readonly #snapshot: () => Record<string, WorkerState>;
	#cache: Record<string, WorkerState> | undefined;
	#queued = false;
	constructor(snapshot: () => Record<string, WorkerState>, batch: Batch) {
		super(batch);
		this.#snapshot = snapshot;
	}
	get value(): JsonValue {
		return (this.#cache ??= this.#snapshot()) as unknown as JsonValue;
	}
	deliver(context: Context): void {
		const value = this.value;
		this.publish(value, [["r", value]], false, context);
	}
	refresh(): void {
		this.#cache = undefined;
		if (this.#queued || (!this.watched && !this.dependents.size)) return;
		this.#queued = true;
		queueMicrotask(() => {
			this.#queued = false;
			this.batch.within(() => this.changed(), BACKGROUND_CONTEXT);
		});
	}
}
