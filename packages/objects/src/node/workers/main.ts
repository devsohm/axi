import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Address } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import type { Host, LoadReport, PluginFacet, ReloadReport, ActivityCounts } from "../../host/index.ts";
import { ipcLink, type IpcPort, type Link } from "../../link/index.ts";
import type { Watchable } from "../../watch.ts";
import type { HostPackages } from "../plugins/evaluate.ts";
import { createPluginRuntime, type PluginScript } from "../plugins/runtime.ts";
import {
	controlOf,
	envelope,
	crossed,
	crossedReport,
	type CrossedError,
	type FromWorker,
	type ToWorker,
} from "./control.ts";
import { processLock } from "./lock.ts";
export type WorkerStart = {
	readonly address: Address;
	readonly start: JsonValue;
	readonly parent: Link;
	readonly plugins: WorkerPlugins;
	onClose(closer: (context: Context) => Promise<void> | void): void;
};
export interface WorkerPlugins {
	load<P extends Principal>(
		host: Host<P>,
		options: { readonly kind: string; readonly core: readonly PluginFacet<P>[] },
		context: Context,
	): Promise<LoadReport>;
}
export type WorkerResult = { readonly busy?: Watchable<Readonly<Record<string, number>>> };
export type WorkerMainOptions = {
	readonly hostPackages: HostPackages;
	readonly redact: (error: unknown) => CrossedError;
	readonly onError: (error: unknown) => void;
};
export function workerMain(
	fn: (start: WorkerStart, context: Context) => Promise<WorkerResult | undefined>,
	options: WorkerMainOptions,
): void {
	new WorkerRuntime(process as unknown as IpcPort, options).start(fn);
}
class WorkerRuntime {
	readonly #port: IpcPort;
	readonly #options: WorkerMainOptions;
	readonly #abort = new AbortController();
	readonly #context = withAbortSignal(this.#abort.signal, BACKGROUND_CONTEXT);
	readonly #closers: ((context: Context) => Promise<void> | void)[] = [];
	readonly #input = Promise.withResolvers<Extract<ToWorker, { kind: "start" }>>();
	readonly #updates: (readonly PluginScript[])[] = [];
	#reload: ((scripts: readonly PluginScript[], context: Context) => Promise<ReloadReport>) | undefined;
	#activity: Watchable<ActivityCounts> | undefined;
	#busy: WorkerResult["busy"];
	#ready = false;
	#loading = false;
	#stopping = false;
	#idle: boolean | undefined;
	constructor(port: IpcPort, options: WorkerMainOptions) {
		this.#port = port;
		this.#options = options;
		port.on("message", (data) => {
			const message = controlOf<ToWorker>(data);
			if (message === undefined) return;
			switch (message.kind) {
				case "start":
					this.#input.resolve(message);
					break;
				case "shutdown":
					void this.#stop();
					break;
				case "reload":
					if (!this.#stopping) {
						this.#updates.push(message.scripts);
						if (this.#ready) void this.#drain();
					}
					break;
			}
		});
		port.on("disconnect", () => {
			void this.#stop();
		});
		for (const signal of ["SIGTERM", "SIGINT"] as const)
			process.once(signal, () => {
				void this.#stop();
			});
		process.once("uncaughtException", (error) => this.#fatal(error));
		process.once("unhandledRejection", (error) => this.#fatal(error));
	}
	start(fn: (start: WorkerStart, context: Context) => Promise<WorkerResult | undefined>): void {
		void this.#run(fn).catch((error) => {
			if (!this.#stopping) this.#fatal(error);
		});
	}
	async #run(fn: (start: WorkerStart, context: Context) => Promise<WorkerResult | undefined>): Promise<void> {
		const input = await this.#input.promise;
		await processLock(input.lock, this.#context);
		const parent = new ParentLink(ipcLink(this.#port), () => this.#send({ kind: "started" })),
			runtime = createPluginRuntime();
		let report: LoadReport = { failed: [] };
		const plugins: WorkerPlugins = {
			load: async (host, { kind, core }, context) => {
				this.#activity = host.activity;
				this.#reload = (scripts, current) => runtime.reload(host, scripts, current);
				report = await runtime.load(
					host,
					{ kind, core, scripts: input.scripts, modules: this.#options.hostPackages },
					context,
				);
				return report;
			},
		};
		const result = await fn(
			{
				address: input.address,
				start: input.start,
				parent,
				plugins,
				onClose: (closer) => {
					this.#closers.push(closer);
				},
			},
			this.#context,
		);
		if (this.#stopping) return;
		this.#busy = result?.busy;
		const observables: Watchable<unknown>[] = [];
		if (this.#activity) observables.push(this.#activity);
		if (this.#busy) observables.push(this.#busy);
		for (const value of observables) {
			const watch = await value.watch(this.#context);
			watch.start(async () => this.#changed());
		}
		this.#ready = true;
		const failed = new Set(report.failed.map((entry) => entry.plugin));
		const full: ReloadReport = {
			plugins: {
				added: input.scripts.map((entry) => entry.plugin.name).filter((name) => !failed.has(name)),
				changed: [],
				removed: [],
			},
			failed: report.failed,
			objects: [],
		};
		this.#idle = this.#isIdle();
		this.#send({ kind: "ready", idle: this.#idle, report: crossedReport(full) });
		void this.#drain();
	}
	#isIdle(): boolean {
		if (this.#loading) return false;
		const activity = this.#activity?.value;
		return (
			!(activity && activity.references + activity.jobs + activity.lingering > 0) &&
			Object.values(this.#busy?.value ?? {}).every((value) => value === 0)
		);
	}
	#changed(): void {
		if (!this.#ready) return;
		const idle = this.#isIdle();
		if (this.#idle === idle) return;
		this.#idle = idle;
		this.#send({ kind: "idle", idle });
	}
	async #drain(): Promise<void> {
		if (this.#loading || !this.#updates.length) return;
		const reload = this.#reload;
		this.#loading = true;
		this.#changed();
		while (this.#updates.length && !this.#stopping) {
			const scripts = this.#updates.shift()!;
			if (!reload) {
				this.#send({ kind: "reloaded", error: { message: "worker: plugins.load was never called" } });
				continue;
			}
			try {
				this.#send({ kind: "reloaded", report: crossedReport(await reload(scripts, this.#context)) });
			} catch (error) {
				this.#send({ kind: "reloaded", error: crossed(error) });
			}
		}
		this.#loading = false;
		this.#changed();
	}
	async #stop(): Promise<void> {
		if (this.#stopping) return;
		this.#stopping = true;
		this.#abort.abort(new Error("worker: shutting down"));
		setTimeout(() => process.exit(0), 3000).unref();
		for (const close of this.#closers.reverse()) {
			try {
				await close(BACKGROUND_CONTEXT);
			} catch (error) {
				this.#options.onError(error);
			}
		}
		process.exit(0);
	}
	#fatal(error: unknown): void {
		this.#options.onError(error);
		let publicError: CrossedError;
		try {
			publicError = this.#options.redact(error);
		} catch {
			publicError = { message: "worker: fatal error" };
		}
		if (!this.#port.connected) process.exit(1);
		(process.send as (message: unknown, done: () => void) => void)(
			envelope({ kind: "fatal", error: publicError }),
			() => process.exit(1),
		);
	}
	#send(message: FromWorker): void {
		if (this.#port.connected) process.send?.(envelope(message), undefined, undefined, () => {});
	}
}
class ParentLink implements Link {
	readonly #inner: Link;
	#connected: (() => void) | undefined;
	constructor(inner: Link, connected: () => void) {
		this.#inner = inner;
		this.#connected = connected;
	}
	send(bytes: Uint8Array): void {
		this.#inner.send(bytes);
	}
	onMessage(receive: (bytes: Uint8Array) => void): void {
		this.#inner.onMessage(receive);
		// Acknowledge startup only after the child can receive the parent's messages.
		const callback = this.#connected;
		this.#connected = undefined;
		callback?.();
	}
	onClose(close: () => void): void {
		this.#inner.onClose(close);
	}
	close(): void {
		this.#inner.close();
	}
}
