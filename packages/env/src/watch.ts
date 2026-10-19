import type { Context } from "@axi/chord";
import { FileError, type FileWatcher, type WatchChange, type WatchTarget } from "@axi/durable/env";
import { type Connection, isConnectionLost } from "./connection.ts";
import { toFileError } from "./errors.ts";

export interface RemoteWatchOptions {
	mode?: "native" | "polling";
	pollIntervalMs?: number;
	maxDirectories?: number;
}
export class RemoteWatcher implements FileWatcher {
	#closed = false;
	#mode: "native" | "polling" = "native";
	#abort: AbortController | undefined;
	#settled: Promise<void> | undefined;
	#wake: (() => void) | undefined;
	readonly #connection: Connection;
	readonly #targets: readonly WatchTarget[];
	readonly #notify: (change: WatchChange) => void;
	readonly #options: RemoteWatchOptions;
	private constructor(
		connection: Connection,
		targets: readonly WatchTarget[],
		notify: (change: WatchChange) => void,
		options: RemoteWatchOptions,
	) {
		this.#connection = connection;
		this.#targets = targets;
		this.#notify = notify;
		this.#options = options;
	}
	static async open(
		connection: Connection,
		targets: readonly WatchTarget[],
		notify: (change: WatchChange) => void,
		options: RemoteWatchOptions = {},
	): Promise<RemoteWatcher> {
		const watcher = new RemoteWatcher(connection, targets, notify, options);
		await watcher.#start();
		return watcher;
	}
	get mode(): "native" | "polling" {
		return this.#mode;
	}
	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#wake?.();
		this.#abort?.abort();
		await this.#settled;
	}
	#deliver(change: WatchChange): void {
		if (!this.#closed) {
			try {
				this.#notify(change);
			} catch {}
		}
	}
	#start(): Promise<void> {
		return new Promise((resolve, reject) => {
			let opened = false;
			this.#abort = new AbortController();
			this.#settled = this.#connection
				.request(
					"watch",
					{
						targets: this.#targets.map((target) => ({
							path: target.path,
							recursive: target.recursive === true,
							exclude: { hidden: target.exclude?.hidden === true, names: [...(target.exclude?.names ?? [])] },
						})),
						...this.#options,
					},
					{
						signal: this.#abort.signal,
						onEvent: (event) => {
							if (event.kind === "ready") {
								opened = true;
								this.#mode = event.mode === "polling" ? "polling" : "native";
								resolve();
							} else if (event.kind === "change") {
								if (event.mode === "polling") this.#mode = "polling";
								this.#deliver(event.overflow === true ? { overflow: true } : { paths: event.paths as string[] });
							} else if (event.kind === "error") {
								this.#deliver({
									error: new FileError(
										event.code === "permission_denied" ? "permission_denied" : "invalid",
										String(event.message),
									),
								});
								this.#closed = true;
							}
						},
					},
				)
				.then(
					() => {},
					(error: unknown) => {
						if (!opened) {
							reject(error);
							return;
						}
						if (this.#closed) return;
						if (isConnectionLost(error)) {
							void this.#reconnect();
							return;
						}
						this.#deliver({ error: toFileError(error) });
						this.#closed = true;
					},
				);
		});
	}
	async #reconnect(): Promise<void> {
		let delay = 1000;
		while (!this.#closed) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, delay);
				timer.unref();
				this.#wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
			this.#wake = undefined;
			if (this.#closed) return;
			try {
				await this.#start();
				this.#deliver({ overflow: true });
				return;
			} catch (error) {
				if (!isConnectionLost(error)) {
					this.#deliver({ error: toFileError(error) });
					this.#closed = true;
					return;
				}
			}
			delay = Math.min(delay * 2, 30000);
		}
	}
}
