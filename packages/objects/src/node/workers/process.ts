import { fork, type ChildProcess } from "node:child_process";
import { ipcLink, type Link } from "../../link/index.ts";
import { controlOf, envelope, type ToWorker, type FromWorker } from "./control.ts";
export type ForkOptions = {
	readonly entry: string;
	readonly execArgv?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly onOutput?: (stream: "stdout" | "stderr", chunk: Uint8Array) => void;
};
export type Exit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };
export type ProcessEvents = {
	readonly control: (message: FromWorker) => void;
	readonly linkLost: () => void;
	readonly linkClosed: () => void;
	readonly exited: (exit: Exit) => void;
};
export class WorkerProcess {
	readonly pid: number;
	readonly startedAt = Date.now();
	readonly link: Link;
	readonly exited: Promise<Exit>;
	readonly #child: ChildProcess;
	#tail = "";
	constructor(options: ForkOptions, events: ProcessEvents) {
		const child = fork(options.entry, [], {
			env: { ...process.env, ...options.env },
			execArgv: [...(options.execArgv ?? [])],
			detached: true,
			serialization: "advanced",
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		this.#child = child;
		this.pid = child.pid ?? -1;
		for (const stream of ["stdout", "stderr"] as const)
			child[stream]?.on("data", (data: Buffer) => {
				if (stream === "stderr") this.#tail = (this.#tail + data.toString("utf8")).slice(-4096);
				if (options.onOutput) options.onOutput(stream, data);
				else process[stream].write(data);
			});
		this.link = new ReportedLink(ipcLink(child), events);
		child.on("message", (data: unknown) => {
			const message = controlOf<FromWorker>(data);
			if (message !== undefined) events.control(message);
		});
		this.exited = new Promise((resolve) => {
			const ended = (exit: Exit): void => {
				this.#killGroup();
				resolve(exit);
				events.exited(exit);
			};
			child.once("exit", (code, signal) => ended({ code, signal }));
			child.once("error", () => {
				if (child.pid === undefined) ended({ code: null, signal: null });
			});
		});
	}
	get stderrTail(): string | undefined {
		return this.#tail || undefined;
	}
	send(message: ToWorker): void {
		if (this.#child.connected) this.#child.send(envelope(message), () => {});
	}
	kill(): void {
		if (!this.#killGroup()) this.#child.kill("SIGKILL");
	}
	#killGroup(): boolean {
		if (this.pid <= 0) return false;
		try {
			process.kill(-this.pid, "SIGKILL");
			return true;
		} catch {
			return false;
		}
	}
}
class ReportedLink implements Link {
	readonly #inner: Link;
	readonly #events: Pick<ProcessEvents, "linkLost" | "linkClosed">;
	#closed = false;
	#notify: (() => void) | undefined;
	constructor(inner: Link, events: Pick<ProcessEvents, "linkLost" | "linkClosed">) {
		this.#inner = inner;
		this.#events = events;
		inner.onClose(() => {
			const local = this.#closed;
			this.#closed = true;
			this.#notify?.();
			if (!local) events.linkClosed();
		});
	}
	send(bytes: Uint8Array): void {
		this.#inner.send(bytes);
	}
	onMessage(receive: (bytes: Uint8Array) => void): void {
		this.#inner.onMessage(receive);
	}
	onClose(notify: () => void): void {
		if (this.#closed) notify();
		else this.#notify = notify;
	}
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#events.linkLost();
		this.#inner.close();
	}
}
