import { RemoteError, type Connection } from "./connection.ts";

export interface ProcessOptions {
	cwd: string;
	argv: readonly string[];
	env?: Record<string, string>;
	inheritEnv?: boolean;
	onStdout: (bytes: Uint8Array) => void;
	onStderr?: (bytes: Uint8Array) => void;
}
export class RemoteProcess {
	readonly pid: number;
	readonly exited: Promise<number>;
	readonly #connection: Connection;
	readonly #request: { id: number; session: number };
	readonly #abort: AbortController;
	constructor(
		connection: Connection,
		id: number,
		session: number,
		pid: number,
		exited: Promise<number>,
		abort: AbortController,
	) {
		this.#connection = connection;
		this.#request = { id, session };
		this.#abort = abort;
		this.pid = pid;
		this.exited = exited;
	}
	write(data: Uint8Array | string): void {
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
		for (let offset = 0; offset < bytes.byteLength; offset += 1048576)
			this.#send("processWrite", bytes.subarray(offset, offset + 1048576));
	}
	closeStdin(): void {
		this.#send("processCloseStdin");
	}
	close(): void {
		this.#abort.abort();
	}
	#send(op: string, payload?: Uint8Array): void {
		void this.#connection
			.request(op, { target: this.#request.id }, { session: this.#request.session, ...(payload ? { payload } : {}) })
			.catch(() => {});
	}
}
export async function openProcess(connection: Connection, options: ProcessOptions): Promise<RemoteProcess> {
	if (!(await connection.info()).features?.includes("process"))
		throw new RemoteError({ code: "not_supported", message: "The Axi Env daemon cannot run processes; update it" });
	const ready = Promise.withResolvers<RemoteProcess>(),
		abort = new AbortController();
	let request: { id: number; session: number } | undefined;
	const exited = connection
		.request(
			"process",
			{
				cwd: options.cwd,
				argv: options.argv,
				...(options.env === undefined ? {} : { env: options.env }),
				...(options.inheritEnv === undefined ? {} : { inheritEnv: options.inheritEnv }),
			},
			{
				signal: abort.signal,
				onStart: (id, session) => {
					request = { id, session };
				},
				onEvent: (event, bytes) => {
					if (event.kind === "output") {
						if (event.stream === "stderr") options.onStderr?.(bytes);
						else options.onStdout(bytes);
					} else if (event.kind === "started" && request)
						ready.resolve(new RemoteProcess(connection, request.id, request.session, Number(event.pid), exited, abort));
				},
			},
		)
		.then(({ json }) => Number(json.exitCode));
	void exited.catch(ready.reject);
	return ready.promise;
}
