import type { Context } from "@axi/objects/context";
import type { JsonValue } from "@axi/objects/json";
import type * as T from "../types.ts";
import { freezeRecord, LruMap } from "./record-cache.ts";
type Task = T.TaskRecord<JsonValue, JsonValue, JsonValue>;

export function scopeOf(storage: T.Storage): T.Storage["publishing"] {
	return storage.publishing?.bind(storage);
}

export class CachedStorage implements T.Storage {
	readonly #source: T.Storage;
	readonly #conversations = new LruMap<T.ConversationId, T.ConversationRecord>(4096);
	readonly #ended = new LruMap<T.TaskId, Task>(256);
	readonly #live = new Map<T.TaskId, Task>();
	readonly #submissions = new LruMap<T.SubmissionId, T.SubmissionRecord>(256);
	readonly #dependencies = new Map<T.TaskId, { count: number; record?: Task }>();
	readonly #waiting = new Map<T.TaskId, { on: readonly T.TaskId[]; resumed: boolean }>();
	readonly #reading = new Map<number, { count: number; version: number }>();
	constructor(storage: T.Storage) {
		this.#source = storage;
	}
	get publishing(): T.Storage["publishing"] {
		return scopeOf(this.#source);
	}
	commit: T.Storage["commit"] = (...args) => this.#source.commit(...args);
	mintId: T.Storage["mintId"] = () => this.#source.mintId();
	scanConversations: T.Storage["scanConversations"] = (...args) => this.#source.scanConversations(...args);
	scanEntries: T.Storage["scanEntries"] = (...args) => this.#source.scanEntries(...args);
	findLatestHeadMarker: T.Storage["findLatestHeadMarker"] = (...args) => this.#source.findLatestHeadMarker(...args);
	scanTasks: T.Storage["scanTasks"] = (...args) => this.#source.scanTasks(...args);
	scanSubmissions: T.Storage["scanSubmissions"] = (...args) => this.#source.scanSubmissions(...args);
	submissionByRequest: T.Storage["submissionByRequest"] = (...args) => this.#source.submissionByRequest(...args);
	findDocument: T.Storage["findDocument"] = (...args) => this.#source.findDocument(...args);
	document: T.Storage["document"] = (...args) => this.#source.document(...args);
	scanDocuments: T.Storage["scanDocuments"] = (...args) => this.#source.scanDocuments(...args);
	close: T.Storage["close"] = (...args) => this.#source.close(...args);
	entry(id: T.EntryId, context: Context): ReturnType<T.Storage["entry"]>;
	entry(conversation: T.ConversationId, id: T.EntryId, context: Context): ReturnType<T.Storage["entry"]>;
	entry(...args: [T.EntryId, Context] | [T.ConversationId, T.EntryId, Context]): ReturnType<T.Storage["entry"]> {
		return args.length === 2 ? this.#source.entry(...args) : this.#source.entry(...args);
	}
	conversation(id: T.ConversationId, context: Context): Promise<T.ConversationRecord | undefined> {
		const cached = this.#conversations.get(id);
		return cached === undefined
			? this.#read(
					id,
					() => this.#source.conversation(id, context),
					(record) => this.#conversations.set(id, record),
				)
			: Promise.resolve(cached);
	}
	task(id: T.TaskId, context: Context): Promise<Task | undefined> {
		const cached = this.#live.get(id) ?? this.#dependencies.get(id)?.record ?? this.#ended.get(id);
		return cached === undefined
			? this.#read(
					id,
					() => this.#source.task(id, context),
					(record) => this.#keep(record),
				)
			: Promise.resolve(cached);
	}
	submission(id: T.SubmissionId, context: Context): Promise<T.SubmissionRecord | undefined> {
		const cached = this.#submissions.get(id);
		return cached === undefined ? this.#source.submission(id, context) : Promise.resolve(cached);
	}
	published(writes: readonly T.StorageWrite[]): void {
		for (const write of writes) {
			if (write.type !== "conversation" && write.type !== "task" && write.type !== "submission") continue;
			const pending = this.#reading.get(write.value.id);
			if (pending) pending.version++;
			switch (write.type) {
				case "conversation":
					this.#conversations.set(write.value.id, freezeRecord(write.value));
					break;
				case "submission":
					this.#submissions.set(write.value.id, freezeRecord(write.value));
					break;
				case "task":
					this.#follow(write.value);
					this.#keep(freezeRecord(write.value));
					break;
			}
		}
	}
	#keep(record: Task): void {
		if (record.state.status !== "terminal") {
			this.#ended.delete(record.id);
			this.#live.set(record.id, record);
			return;
		}
		this.#live.delete(record.id);
		const dependency = this.#dependencies.get(record.id);
		if (dependency) dependency.record = record;
		else this.#ended.set(record.id, record);
	}
	#follow(record: Task): void {
		const previous = this.#waiting.get(record.id);
		if (record.state.status === "waiting") {
			if (previous) this.#release(previous.on);
			this.#waiting.set(record.id, { on: record.state.on, resumed: false });
			for (const id of record.state.on) {
				let dependency = this.#dependencies.get(id);
				if (!dependency) {
					dependency = { count: 0, record: this.#ended.get(id) };
					this.#ended.delete(id);
					this.#dependencies.set(id, dependency);
				}
				dependency.count++;
			}
		} else if (previous) {
			if (!previous.resumed && record.state.status !== "terminal") previous.resumed = true;
			else {
				this.#waiting.delete(record.id);
				this.#release(previous.on);
			}
		}
	}
	#release(ids: readonly T.TaskId[]): void {
		for (const id of ids) {
			const dependency = this.#dependencies.get(id)!;
			if (--dependency.count === 0) {
				this.#dependencies.delete(id);
				if (dependency.record) this.#ended.set(id, dependency.record);
			}
		}
	}
	async #read<Value extends object>(
		id: number,
		read: () => Promise<Value | undefined>,
		keep: (value: Value) => void,
	): Promise<Value | undefined> {
		let pending = this.#reading.get(id);
		if (!pending) {
			pending = { count: 0, version: 0 };
			this.#reading.set(id, pending);
		}
		pending.count++;
		const version = pending.version;
		let value: Value | undefined;
		try {
			value = await read();
		} finally {
			if (--pending.count === 0) this.#reading.delete(id);
		}
		if (value !== undefined) {
			freezeRecord(value);
			if (pending.version === version) keep(value);
		}
		return value;
	}
	get readsInFlight(): number {
		return this.#reading.size;
	}
	get sizes() {
		return {
			conversations: this.#conversations.size,
			tasks: this.#ended.size,
			liveTasks: this.#live.size,
			awaited: this.#dependencies.size,
			waits: this.#waiting.size,
			submissions: this.#submissions.size,
		};
	}
}
