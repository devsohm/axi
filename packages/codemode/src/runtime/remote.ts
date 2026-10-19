import type { CodemodeError, CodemodeSandboxBaseOptions } from "../types.ts";
import type { CodemodeWasmModule } from "../wasm.ts";
import { CodemodeSandboxBase, errorMessage, type VmChannel, type VmLauncher } from "./execution.ts";
import { DEFAULT_INTERRUPT_BUDGET, inlineLauncher } from "./inline.ts";
import {
	isWorkerToHostMessage,
	type HostToWorkerMessage,
	type VmStartData,
	type WorkerToHostMessage,
} from "./protocol.ts";
export interface CodemodeRemoteRequest {
	data: VmStartData;
	interruptBudget?: number;
}
export type CodemodeRemoteMessage = WorkerToHostMessage | { type: "failure"; error: CodemodeError };
export type CodemodeRemoteReply = HostToWorkerMessage | { type: "stop" } | null;
export type CodemodeRemoteExchange = (messages: CodemodeRemoteMessage[]) => Promise<CodemodeRemoteReply>;
export interface CodemodeRemote {
	execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange): Promise<void>;
}
export interface RemoteCodemodeSandboxOptions extends CodemodeSandboxBaseOptions {
	remote: () => CodemodeRemote;
	interruptBudget?: number;
}
export interface CodemodeServeOptions {
	wasm: CodemodeWasmModule | Promise<CodemodeWasmModule>;
	maxInterruptBudget?: number;
	maxMemoryLimitBytes?: number;
}
export function serveCodemodeRemote(
	request: CodemodeRemoteRequest,
	exchange: CodemodeRemoteExchange,
	options: CodemodeServeOptions,
): Promise<void> {
	const limit = options.maxInterruptBudget ?? DEFAULT_INTERRUPT_BUDGET;
	const budget = Math.min(limit, request.interruptBudget ?? limit);
	const requested = request.data.memoryLimitBytes,
		cap = options.maxMemoryLimitBytes;
	const data = {
		...request.data,
		memoryLimitBytes: requested === undefined ? cap : cap === undefined ? requested : Math.min(cap, requested),
	};
	return new Promise((resolve) => {
		let channel: VmChannel | undefined,
			ended = false,
			buffer: CodemodeRemoteMessage[] = [],
			size = 0;
		const replies: HostToWorkerMessage[] = [];
		const take = (): CodemodeRemoteMessage[] => {
			const batch = buffer;
			buffer = [];
			size = 0;
			return batch;
		};
		const finish = (message?: CodemodeRemoteMessage): void => {
			if (ended) return;
			ended = true;
			const batch = take();
			void (message ? exchange([...batch, message]).catch(() => null) : Promise.resolve())
				.then(() => channel?.stop())
				.catch(() => undefined)
				.then(() => resolve());
		};
		const accept = (reply: CodemodeRemoteReply): void => {
			if (ended || reply === null) return;
			if (reply.type === "stop") {
				finish();
				return;
			}
			if (channel) channel.post(reply);
			else replies.push(reply);
		};
		const send = (batch: CodemodeRemoteMessage[]): void => {
			void exchange(batch).then(accept, () => finish());
		};
		const message = (raw: unknown): void => {
			if (ended) return;
			const value = raw as WorkerToHostMessage;
			switch (value.type) {
				case "output":
					buffer.push(value);
					size += value.item.type === "text" ? value.item.text.length : value.item.data.length;
					if (buffer.length >= 1000 || size >= 1048576) send(take());
					break;
				case "started":
					buffer.push(value);
					break;
				case "call":
				case "idle":
					send([...take(), value]);
					break;
				default:
					finish(value);
					break;
			}
		};
		Promise.resolve(
			inlineLauncher(options.wasm, budget)(data, { message, failure: (error) => finish({ type: "failure", error }) }),
		).then(
			(started) => {
				channel = started;
				if (ended) {
					void started.stop().catch(() => undefined);
					return;
				}
				for (const reply of replies.splice(0)) started.post(reply);
			},
			(error) => finish({ type: "failure", error: { kind: "sandbox", message: errorMessage(error) } }),
		);
	});
}
function remoteLauncher(options: Pick<RemoteCodemodeSandboxOptions, "remote" | "interruptBudget">): VmLauncher {
	const { remote, interruptBudget } = options;
	return (data, events) => {
		let stopped = false,
			terminal = false;
		const answers = new Map<number, (reply: CodemodeRemoteReply) => void>();
		const exchange: CodemodeRemoteExchange = (messages) =>
			new Promise((resolve) => {
				if (stopped || !Array.isArray(messages)) {
					resolve({ type: "stop" });
					return;
				}
				const call = messages.find((v) => isWorkerToHostMessage(v) && v.type === "call");
				if (call?.type === "call") answers.set(call.id, resolve);
				else resolve(null);
				for (const value of messages) {
					if (typeof value === "object" && value !== null && value.type === "failure") {
						terminal = true;
						events.failure(value.error);
						continue;
					}
					events.message(value);
					if (isWorkerToHostMessage(value) && (value.type === "done" || value.type === "crash")) terminal = true;
				}
			});
		let target: CodemodeRemote;
		try {
			target = remote();
		} catch (error) {
			throw new Error(`Failed to reach the remote sandbox: ${errorMessage(error)}`);
		}
		const request: CodemodeRemoteRequest = {
			data,
			...(interruptBudget === undefined ? {} : { interruptBudget }),
		};
		void Promise.resolve()
			.then(() => target.execute(request, exchange))
			.then(
				() => {
					if (!stopped && !terminal)
						events.failure({ kind: "sandbox", message: "Remote sandbox returned before the script settled" });
				},
				(error) => {
					if (!stopped) events.failure({ kind: "sandbox", message: `Remote sandbox failed: ${errorMessage(error)}` });
				},
			);
		return {
			post(message) {
				const answer = answers.get(message.id);
				answers.delete(message.id);
				answer?.(message);
			},
			async stop() {
				stopped = true;
				for (const answer of answers.values()) answer({ type: "stop" });
				answers.clear();
			},
		};
	};
}
export class RemoteCodemodeSandbox extends CodemodeSandboxBase {
	constructor(options: RemoteCodemodeSandboxOptions) {
		super(options, remoteLauncher(options));
	}
}
