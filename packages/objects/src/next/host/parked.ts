import type { Context } from "../../context/index.ts";
import { ObjectsError } from "../data/index.ts";

type WaitingCall = {
	readonly method: string;
	readonly args: unknown;
	readonly context: Context;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
	readonly until: number;
	readonly timer: ReturnType<typeof setTimeout>;
	readonly aborted: (() => void) | undefined;
};
export class ParkedCalls {
	readonly #calls = new Set<WaitingCall>();
	readonly #timeout: number;
	readonly #label: string;
	constructor(timeout: number, label: string) {
		this.#timeout = timeout;
		this.#label = label;
	}
	get waiting(): boolean {
		return this.#calls.size !== 0;
	}
	park(method: string, args: unknown, context: Context): Promise<unknown> {
		const signal = context.abortSignal;
		signal?.throwIfAborted();
		return new Promise((resolve, reject) => {
			const aborted = signal
				? () => {
						this.#take(call);
						reject(signal.reason);
					}
				: undefined;
			const call: WaitingCall = {
				method,
				args,
				context,
				resolve,
				reject,
				until: Date.now() + this.#timeout,
				timer: setTimeout(() => this.#expired(call), this.#timeout),
				aborted,
			};
			if (aborted) signal!.addEventListener("abort", aborted, { once: true });
			this.#calls.add(call);
		});
	}
	flush(send: (method: string, args: unknown, context: Context) => Promise<unknown>, live: () => boolean): void {
		for (const call of this.#calls) {
			if (!live()) return;
			if (Date.now() >= call.until) {
				this.#expired(call);
				continue;
			}
			this.#take(call);
			void send(call.method, call.args, call.context).then(call.resolve, call.reject);
		}
	}
	reject(error: unknown): void {
		for (const call of this.#calls) {
			this.#take(call);
			call.reject(error);
		}
	}
	#expired(call: WaitingCall): void {
		this.#take(call);
		call.reject(
			new ObjectsError({
				code: "unavailable",
				reason: "park_timeout",
				message: `${this.#label}: a call waited ${this.#timeout} ms for its reference to go live`,
			}),
		);
	}
	#take(call: WaitingCall): void {
		this.#calls.delete(call);
		clearTimeout(call.timer);
		if (call.aborted) call.context.abortSignal?.removeEventListener("abort", call.aborted);
	}
}
