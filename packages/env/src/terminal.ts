import type { Connection, Json } from "./connection.ts";

export interface TerminalOptions {
	cwd: string;
	argv?: readonly string[];
	env?: Record<string, string>;
	inheritEnv?: boolean;
	cols: number;
	rows: number;
	onData(bytes: Uint8Array): void;
}
export interface TerminalForeground {
	pid: number;
	name?: string;
}
export class RemoteTerminal {
	readonly #connection: Connection;
	readonly #requestId: number;
	readonly #session: number;
	readonly pid: number;
	readonly exited: Promise<number>;
	readonly #abort: AbortController;
	constructor(
		connection: Connection,
		requestId: number,
		session: number,
		pid: number,
		exited: Promise<number>,
		abort: AbortController,
	) {
		this.#connection = connection;
		this.#requestId = requestId;
		this.#session = session;
		this.pid = pid;
		this.exited = exited;
		this.#abort = abort;
	}
	write(data: Uint8Array | string): void {
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
		for (let at = 0; at < bytes.length; at += 1048576) this.#send("ptyWrite", {}, bytes.subarray(at, at + 1048576));
	}
	resize(cols: number, rows: number): void {
		this.#send("ptyResize", { cols, rows });
	}
	close(): void {
		this.#abort.abort();
	}
	async foreground(): Promise<TerminalForeground | undefined> {
		const { json } = await this.#connection.request(
			"ptyForeground",
			{ target: this.#requestId },
			{ session: this.#session },
		);
		const job = json.foreground as { pid: number; name: string | null } | null;
		return job ? { pid: job.pid, ...(job.name ? { name: job.name } : {}) } : undefined;
	}
	#send(op: string, fields: Json, payload?: Uint8Array): void {
		void this.#connection
			.request(op, { ...fields, target: this.#requestId }, { session: this.#session, ...(payload ? { payload } : {}) })
			.catch(() => {});
	}
}
export function openTerminal(connection: Connection, options: TerminalOptions): Promise<RemoteTerminal> {
	const ready = Promise.withResolvers<RemoteTerminal>(),
		abort = new AbortController();
	let owner: { id: number; session: number } | undefined;
	const exited = connection
		.request(
			"pty",
			{
				cwd: options.cwd,
				...(options.argv === undefined ? {} : { argv: options.argv }),
				...(options.env === undefined ? {} : { env: options.env }),
				...(options.inheritEnv === undefined ? {} : { inheritEnv: options.inheritEnv }),
				cols: options.cols,
				rows: options.rows,
			},
			{
				signal: abort.signal,
				onStart: (id, session) => {
					owner = { id, session };
				},
				onEvent: (event, payload) => {
					if (event.kind === "output") options.onData(payload);
					else if (event.kind === "started" && owner)
						ready.resolve(new RemoteTerminal(connection, owner.id, owner.session, Number(event.pid), exited, abort));
				},
			},
		)
		.then(({ json }) => Number(json.exitCode));
	void exited.catch(ready.reject);
	return ready.promise;
}
