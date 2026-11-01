import { toCodemodeIdentifier } from "../identifier.ts";
import type * as T from "../types.ts";
import {
	isWorkerToHostMessage,
	type HostToWorkerMessage,
	type VmStartData,
	type WorkerToHostMessage,
} from "./protocol.ts";

export interface VmEvents {
	message(message: unknown): void;
	failure(error: T.CodemodeError): void;
}
export interface VmChannel {
	post(message: HostToWorkerMessage): void;
	stop(): Promise<void>;
}
export type VmLauncher = (data: VmStartData, events: VmEvents) => VmChannel | Promise<VmChannel>;
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
class BridgeError extends Error {}
function decode(text: string, subject: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new BridgeError(`${subject} is not valid JSON`);
	}
}
function writes(text: string): T.CodemodeStoreWrites {
	const decoded = decode(text, "store writes");
	if (!Array.isArray(decoded)) throw new BridgeError("store writes are not an array");
	const result: T.CodemodeStoreWrites = { set: {}, delete: [] };
	for (const row of decoded) {
		if (
			!Array.isArray(row) ||
			typeof row[0] !== "string" ||
			!(row.length === 1 || (row.length === 2 && typeof row[1] === "string"))
		)
			throw new BridgeError("store writes contain a malformed entry");
		if (row.length === 1) result.delete.push(row[0]);
		else result.set[row[0]] = decode(row[1], `store value for ${JSON.stringify(row[0])}`);
	}
	return result;
}
function scriptError(text: string): T.CodemodeError {
	const data = decode(text, "script error");
	if (typeof data !== "object" || data === null) throw new BridgeError("script error is not an object");
	const { name, message, stack } = data as Record<string, unknown>;
	if (
		typeof message !== "string" ||
		(name !== undefined && typeof name !== "string") ||
		(stack !== undefined && typeof stack !== "string")
	)
		throw new BridgeError("script error is malformed");
	return { kind: "script", name, message, stack };
}
const reserved = new Set(["tools", "ALL_TOOLS", "console", "text", "image", "exit", "globalThis", "store", "load"]);
function globalsValid(values: readonly T.CodemodeDeclaredGlobal[]): void {
	const seen = new Set<string>(),
		groups = new Set<string>();
	for (const { name } of values) {
		const parts = name.split(".");
		if (parts.length > 2 || parts.some((p) => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p)) || reserved.has(parts[0]))
			throw new Error(`Invalid global name "${name}"`);
		if (seen.has(name)) throw new Error(`Global "${name}" is already registered`);
		seen.add(name);
		if (parts.length === 2) groups.add(parts[0]);
	}
	for (const name of groups)
		if (seen.has(name)) throw new Error(`Global "${name}" conflicts with the namespace "${name}"`);
}
function storeSnapshot(values?: Readonly<Record<string, unknown>>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(values ?? {})) {
		const json = JSON.stringify(value);
		if (json !== undefined) result[key] = json;
	}
	return result;
}
type Control = Pick<T.CodemodeRunOptions, "onStarted" | "onIdle" | "onCall">;
type Pending = { row?: T.CodemodeCall; since: number; controller: AbortController };
type Start = {
	data: Omit<VmStartData, "tools" | "globals">;
	tools: readonly T.CodemodeDeclaredTool[];
	globals: readonly T.CodemodeDeclaredGlobal[];
	timeout: number;
	signal?: AbortSignal;
	control?: Control;
	launch: VmLauncher;
	executors: { tool: ReadonlyMap<string, T.CodemodeTool>; global: ReadonlyMap<string, T.CodemodeTool> };
};
class Invocation {
	readonly result: Promise<T.CodemodeResult>;
	finished = false;
	#resolve!: (result: T.CodemodeResult) => void;
	#channel?: VmChannel;
	#buffer: HostToWorkerMessage[] = [];
	readonly #executors: Start["executors"];
	readonly #control: Control | undefined;
	readonly #signal: AbortSignal | undefined;
	readonly #pending = new Map<number, Pending>();
	readonly #sequences = new Set<number>();
	readonly #output: T.CodemodeOutputItem[] = [];
	readonly #calls: T.CodemodeCall[] = [];
	#timer?: ReturnType<typeof setTimeout>;
	constructor(options: Start) {
		this.#executors = options.executors;
		this.#control = options.control;
		this.#signal = options.signal;
		this.result = new Promise((resolve) => {
			this.#resolve = resolve;
		});
		if (Number.isFinite(options.timeout))
			this.#timer = setTimeout(
				() => this.finish({ kind: "timeout", message: `Execution timed out after ${options.timeout} ms` }),
				options.timeout,
			);
		if (options.signal?.aborted) this.#abort();
		else options.signal?.addEventListener("abort", this.#abort, { once: true });
		if (this.finished) return;
		const data: VmStartData = {
			code: options.data.code,
			tools: options.tools.map((tool) => ({
				name: tool.name,
				jsName: tool.jsName ?? toCodemodeIdentifier(tool.name),
				description: tool.description ?? "",
			})),
			globals: options.globals.map((value) => ({ name: value.name, spread: value.spread === true })),
			memoryLimitBytes: options.data.memoryLimitBytes,
			store: options.data.store,
			...(options.data.deterministic ? { deterministic: options.data.deterministic } : {}),
		};
		new Promise<VmChannel>((resolve) =>
			resolve(
				options.launch(data, {
					message: (message) => this.#receive(message),
					failure: (error) => this.finish(error),
				}),
			),
		).then(
			(channel) => {
				if (this.finished) {
					void channel.stop().catch(() => undefined);
					return;
				}
				this.#channel = channel;
				for (const message of this.#buffer.splice(0)) channel.post(message);
			},
			(error) => this.finish({ kind: "sandbox", message: errorMessage(error) }),
		);
	}
	#abort = (): void => {
		const reason: unknown = this.#signal?.reason;
		this.finish({ kind: "aborted", message: reason instanceof Error ? reason.message : "Execution aborted" });
	};
	#post(message: HostToWorkerMessage): void {
		if (this.#channel) this.#channel.post(message);
		else this.#buffer.push(message);
	}
	deliver(seq: number, now: number, id: number, outcome: T.CodemodeOutcome): void {
		if (this.finished) return;
		if (!Number.isFinite(now)) throw new Error(`The clock value of result ${seq} is not a finite number`);
		if (!Number.isInteger(seq) || seq < 1 || this.#sequences.has(seq))
			throw new Error(`Result number ${seq} is not a positive integer used once`);
		const call = this.#pending.get(id);
		if (!call) throw new Error(`Call ${id} is not waiting for a result`);
		if (!outcome.ok && outcome.properties !== undefined) {
			const { properties } = outcome;
			if (typeof properties !== "object" || properties === null || Array.isArray(properties))
				throw new Error(`The properties of result ${seq} are not an object`);
		}
		const payload = outcome.ok
			? outcome.value === undefined
				? undefined
				: JSON.stringify(outcome.value)
			: outcome.message;
		const properties = !outcome.ok && outcome.properties !== undefined ? JSON.stringify(outcome.properties) : undefined;
		this.#sequences.add(seq);
		this.#pending.delete(id);
		this.#settleCall(call, outcome.ok ? "ok" : "error");
		this.#post({
			type: "result",
			id,
			ok: outcome.ok,
			payload,
			seq,
			now,
			...(properties === undefined ? {} : { properties }),
		});
	}
	#settleCall(call: Pending, status: T.CodemodeCallStatus): void {
		if (call.row) {
			call.row.status = status;
			call.row.durationMs = performance.now() - call.since;
		}
	}
	#receive(value: unknown): void {
		if (this.finished) return;
		try {
			if (!isWorkerToHostMessage(value)) throw new BridgeError("unknown message from the worker");
			switch (value.type) {
				case "output":
					this.#output.push(value.item);
					break;
				case "crash":
					this.finish({ kind: "sandbox", message: value.message });
					break;
				case "started":
					this.#control?.onStarted?.(value.fingerprint);
					break;
				case "idle":
					this.#control?.onIdle?.(value.seq, value.issued);
					break;
				case "done":
					if (value.ok)
						this.finish(
							undefined,
							value.value === undefined ? undefined : decode(value.value, "return value"),
							writes(value.writes),
							value.during,
						);
					else this.finish(scriptError(value.error), undefined, undefined, value.during);
					break;
				case "call":
					this.#call(value);
					break;
			}
		} catch (error) {
			this.finish({
				kind: "sandbox",
				message:
					error instanceof BridgeError
						? `Sandbox bridge broken: ${error.message}. The script may have modified built-ins such as a prototype's toJSON.`
						: `Sandbox host failed: ${errorMessage(error)}`,
			});
		}
	}
	#call(message: Extract<WorkerToHostMessage, { type: "call" }>): void {
		if (this.#pending.has(message.id)) throw new BridgeError(`duplicate call id ${message.id}`);
		const args = this.#control && message.args !== undefined ? decode(message.args, "call arguments") : undefined;
		const row: T.CodemodeCall | undefined =
			message.target === "tool" ? { name: message.name, status: "cancelled", durationMs: 0 } : undefined;
		const call: Pending = { row, since: performance.now(), controller: new AbortController() };
		if (row) this.#calls.push(row);
		this.#pending.set(message.id, call);
		if (this.#control) {
			this.#control.onCall({
				id: message.id,
				target: message.target,
				name: message.name,
				args,
			});
		} else void this.#executeCall(message, call);
	}
	async #executeCall(message: Extract<WorkerToHostMessage, { type: "call" }>, call: Pending): Promise<void> {
		let response: HostToWorkerMessage;
		try {
			const target = message.target === "tool" ? "tool" : "global";
			const tool = this.#executors[target].get(message.name);
			if (!tool) throw new Error(`Unknown ${target} "${message.name}"`);
			const value = await tool.execute(message.args === undefined ? undefined : JSON.parse(message.args), {
				signal: call.controller.signal,
			});
			response = {
				type: "result",
				id: message.id,
				ok: true,
				payload: value === undefined ? undefined : JSON.stringify(value),
			};
		} catch (error) {
			response = { type: "result", id: message.id, ok: false, payload: errorMessage(error) };
		}
		if (!this.#pending.delete(message.id)) return;
		this.#settleCall(call, response.ok ? "ok" : "error");
		this.#post(response);
	}
	finish(
		error?: T.CodemodeError,
		value?: unknown,
		storeWrites: T.CodemodeStoreWrites = { set: {}, delete: [] },
		during?: T.CodemodeDuring,
	): void {
		if (this.finished) return;
		this.finished = true;
		clearTimeout(this.#timer);
		this.#signal?.removeEventListener("abort", this.#abort);
		const now = performance.now();
		for (const call of this.#pending.values()) {
			if (call.row) call.row.durationMs = now - call.since;
			call.controller.abort();
		}
		this.#pending.clear();
		this.#buffer = [];
		const ended = during === undefined ? {} : { during: { seq: during.seq, issued: during.issued } };
		const result: T.CodemodeResult = error
			? { ok: false, error, output: this.#output, calls: this.#calls, ...ended }
			: { ok: true, value, output: this.#output, calls: this.#calls, storeWrites, ...ended };
		if (!this.#channel) {
			this.#resolve(result);
			return;
		}
		void this.#channel
			.stop()
			.catch(() => undefined)
			.then(() => this.#resolve(result));
	}
}
export class CodemodeSandboxBase {
	readonly #tools = new Map<string, T.CodemodeTool>();
	readonly #globals = new Map<string, T.CodemodeTool>();
	readonly #active = new Set<Invocation>();
	readonly #timeout: number;
	readonly #memoryLimit: number | undefined;
	readonly #launch: VmLauncher;
	#closed = false;
	constructor(options: T.CodemodeSandboxBaseOptions, launch: VmLauncher) {
		this.#timeout = options.timeoutMs ?? 300000;
		this.#memoryLimit = options.memoryLimitBytes;
		this.#launch = launch;
		for (const tool of options.tools ?? []) this.registerTool(tool);
		globalsValid(options.globals ?? []);
		for (const global of options.globals ?? []) this.#globals.set(global.name, global);
	}
	registerTool(tool: T.CodemodeTool): void {
		if (this.#tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
		this.#tools.set(tool.name, tool);
	}
	unregisterTool(name: string): boolean {
		return this.#tools.delete(name);
	}
	get tools(): T.CodemodeTool[] {
		return [...this.#tools.values()];
	}
	get globals(): T.CodemodeTool[] {
		return [...this.#globals.values()];
	}
	#start(
		code: string,
		tools: readonly T.CodemodeDeclaredTool[],
		globals: readonly T.CodemodeDeclaredGlobal[],
		options: T.CodemodeExecuteOptions,
		executors: Start["executors"],
		control?: T.CodemodeRunOptions,
	): Invocation {
		const timeout = options.timeoutMs ?? (control ? Infinity : this.#timeout);
		const signal = options.signal;
		const invocation = new Invocation({
			tools,
			globals,
			data: {
				code,
				store: storeSnapshot(options.store),
				memoryLimitBytes: this.#memoryLimit,
				...(control ? { deterministic: { startedAt: control.startedAt, seed: control.seed } } : {}),
			},
			timeout,
			signal,
			control: control ? { onStarted: control.onStarted, onCall: control.onCall, onIdle: control.onIdle } : undefined,
			launch: this.#launch,
			executors,
		});
		this.#active.add(invocation);
		return invocation;
	}
	execute(code: string, options: T.CodemodeExecuteOptions = {}): Promise<T.CodemodeResult> {
		if (this.#closed) return Promise.reject(new Error("Sandbox is closed"));
		const executors = { tool: new Map(this.#tools), global: this.#globals };
		const invocation = this.#start(code, [...executors.tool.values()], [...this.#globals.values()], options, executors);
		return invocation.result.finally(() => this.#active.delete(invocation));
	}
	start(code: string, options: T.CodemodeRunOptions): T.CodemodeRun {
		if (this.#closed) throw new Error("Sandbox is closed");
		if (!Number.isFinite(options.startedAt) || options.startedAt < 0)
			throw new Error("startedAt must be a non-negative number of milliseconds since the epoch");
		if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff)
			throw new Error("seed must be a 32-bit unsigned integer");
		const tools = options.tools ?? [];
		if (new Set(tools.map((v) => v.name)).size !== tools.length) throw new Error("Tool names must be unique");
		if (new Set(tools.map((v) => v.jsName ?? toCodemodeIdentifier(v.name))).size !== tools.length)
			throw new Error("Tool script names must be unique");
		const globals = options.globals ?? [];
		globalsValid(globals);
		const invocation = this.#start(code, tools, globals, options, { tool: new Map(), global: new Map() }, options);
		const result = invocation.result.finally(() => this.#active.delete(invocation));
		return {
			result,
			deliver: (seq, now, id, outcome) => invocation.deliver(seq, now, id, outcome),
			get finished() {
				return invocation.finished;
			},
		};
	}
	async close(): Promise<void> {
		this.#closed = true;
		await Promise.all(
			[...this.#active].map((run) => {
				run.finish({ kind: "aborted", message: "Sandbox closed" });
				return run.result;
			}),
		);
	}
}
