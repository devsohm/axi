import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

class Queue<T> {
	#pending: T[] = [];
	#ready: T[] = [];
	get length(): number {
		return this.#pending.length + this.#ready.length;
	}
	push(value: T): void {
		this.#pending.push(value);
	}
	shift(): T | undefined {
		if (this.#ready.length === 0) while (this.#pending.length > 0) this.#ready.push(this.#pending.pop()!);
		return this.#ready.pop();
	}
}
export class EventStream<T, R = T> implements AsyncIterable<T> {
	readonly #events = new Queue<T>();
	readonly #readers = new Queue<(item: IteratorResult<T>) => void>();
	readonly #result = Promise.withResolvers<R>();
	readonly #isComplete: (event: T) => boolean;
	readonly #extract: (event: T) => R;
	protected done = false;
	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.#isComplete = isComplete;
		this.#extract = extractResult;
	}
	push(event: T): void {
		if (this.done) return;
		if (this.#isComplete(event)) {
			this.done = true;
			this.#result.resolve(this.#extract(event));
		}
		const reader = this.#readers.shift();
		if (reader) reader({ value: event, done: false });
		else this.#events.push(event);
	}
	end(result?: R): void {
		this.done = true;
		if (result !== undefined) this.#result.resolve(result);
		let reader = this.#readers.shift();
		while (reader) {
			reader({ value: undefined, done: true });
			reader = this.#readers.shift();
		}
	}
	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		for (;;) {
			if (this.#events.length) yield this.#events.shift()!;
			else if (this.done) return;
			else {
				const item = await new Promise<IteratorResult<T>>((resolve) => this.#readers.push(resolve));
				if (item.done) return;
				yield item.value;
			}
		}
	}
	result(): Promise<R> {
		return this.#result.promise;
	}
}
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	readonly #started = Date.now();
	readonly #clock = performance.now();
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type for final result");
			},
		);
	}
	override push(event: AssistantMessageEvent): void {
		if (event.type === "done") this.#time(event.message);
		else if (event.type === "error") this.#time(event.error);
		super.push(event);
	}
	override end(result?: AssistantMessage): void {
		if (result !== undefined) this.#time(result);
		super.end(result);
	}
	#time(message: AssistantMessage): void {
		if (this.done || message.durationMs !== undefined || message.timestamp < this.#started) return;
		message.durationMs = Math.max(0, Math.round(performance.now() - this.#clock));
	}
}
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
