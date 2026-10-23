import type { Context } from "@axi/chord";
import type { FileError, FileSystem } from "../../env/index.ts";
import { StorageRequestError } from "../../errors.ts";
import { idFromNumber } from "../../ids.ts";
import type {
	ConversationId,
	DocumentContent,
	DocumentId,
	EntryId,
	Seq,
	Storage,
	StorageWrite,
	TaskId,
} from "../../types.ts";
import { MemoryStorage, type PreparedMemoryCommit } from "../memory.ts";
import {
	currentOnly,
	encodeLine,
	fileName,
	JsonlCorruptionError,
	JsonlStoragePoisonedError,
	type MainWrite,
	type Marker,
	type Payload,
	parseMarker,
	parseSidecar,
	recordKey,
	type Sidecar,
	type StoredTask,
} from "./wire.ts";

export type JsonlStorageOptions = { readonly fsync?: boolean };
type Line<Value> = { readonly value: Value; readonly start: number };
type FileLines<Value> = { readonly path: string; readonly lines: readonly Line<Value>[] };
type Encoded = { readonly marker: string; readonly sidecars: ReadonlyMap<string, string> };
const decoder = new TextDecoder("utf-8", { fatal: true });
const fileError = (action: string, error: FileError): Error =>
	new Error(`JSONL ${action} failed: ${error.message}`, { cause: error });
const before = (seq: number, ordinal: number, base: Sidecar | undefined): boolean =>
	base !== undefined && (seq < base.seq || (seq === base.seq && ordinal < base.ordinal));

export class JsonlStorage implements Storage {
	readonly #memory = new MemoryStorage();
	readonly #currentOnly = new Set<DocumentId>();
	readonly #liveTasks = new Set<TaskId>();
	#closed = false;
	#failure: JsonlStoragePoisonedError | undefined;
	private readonly fs: FileSystem;
	private readonly directory: string;
	private readonly mainPath: string;
	private readonly fsync: boolean;
	private constructor(fs: FileSystem, directory: string, mainPath: string, fsync: boolean) {
		this.fs = fs;
		this.directory = directory;
		this.mainPath = mainPath;
		this.fsync = fsync;
	}

	static async open(
		directory: string,
		fs: FileSystem,
		context: Context,
		options: JsonlStorageOptions = {},
	): Promise<JsonlStorage> {
		const absolute = await fs.absolutePath(directory, context);
		if (!absolute.ok) throw fileError("path resolution", absolute.error);
		const created = await fs.createDir(absolute.value, { recursive: true }, context);
		if (!created.ok) throw fileError("directory creation", created.error);
		const main = await fs.joinPath([absolute.value, "main.jsonl"], context);
		if (!main.ok) throw fileError("path join", main.error);
		const storage = new JsonlStorage(fs, absolute.value, main.value, options.fsync ?? false);
		await storage.#recover(context);
		return storage;
	}
	get #view(): MemoryStorage {
		if (this.#closed) throw new Error("JsonlStorage is closed");
		if (this.#failure) throw this.#failure;
		return this.#memory;
	}
	#poison(cause: Error): JsonlStoragePoisonedError {
		return (this.#failure ??= new JsonlStoragePoisonedError(cause));
	}
	async #path(file: string, context: Context): Promise<string> {
		const result = await this.fs.joinPath([this.directory, file], context);
		if (!result.ok) throw fileError("path join", result.error);
		return result.value;
	}
	async commit(writes: readonly StorageWrite[], adopt: (seq: Seq) => void, context: Context): Promise<Seq> {
		const pending = this.#view.prepareCommit(writes);
		const encoded = this.#encode(pending);
		const replacements = this.#replacements(pending.writes, encoded);
		const sidecars = await Promise.all(
			[...encoded.sidecars].map(async ([file, content]) => ({ file, content, path: await this.#path(file, context) })),
		);
		for (const { file, content, path } of sidecars) {
			const appended = await this.fs.appendFile(path, content, context);
			if (!appended.ok) throw this.#poison(fileError(`append to ${file}`, appended.error));
		}
		if (this.fsync) {
			for (const { file, path } of sidecars) {
				const flushed = await this.fs.flushFile(path, context);
				if (!flushed.ok) throw this.#poison(fileError(`flush of ${file}`, flushed.error));
			}
		}
		const published = await this.fs.appendFile(this.mainPath, encoded.marker, context);
		if (!published.ok) throw this.#poison(fileError("append to main.jsonl", published.error));
		const seq = pending.apply();
		for (const write of pending.writes) {
			if (write.type === "document.create" && currentOnly(write.record)) this.#currentOnly.add(write.record.id);
			if (write.type === "task") {
				if (write.value.state.status === "terminal") this.#liveTasks.delete(write.value.id);
				else this.#liveTasks.add(write.value.id);
			}
		}
		adopt(seq);
		await this.#reclaim(replacements, context);
		return seq;
	}
	#encode(pending: PreparedMemoryCommit): Encoded {
		const writes: MainWrite[] = [];
		const files = new Map<string, string>();
		let ordinal = 0;
		const append = (file: string, payload: Payload): number => {
			const index = ordinal++;
			files.set(
				file,
				(files.get(file) ?? "") + encodeLine({ format: 1, type: "record", seq: pending.seq, ordinal: index, payload }),
			);
			return index;
		};
		for (const write of pending.writes) {
			switch (write.type) {
				case "conversation":
				case "entry":
				case "submission":
				case "document.retire":
					writes.push(write);
					break;
				case "task":
					if (write.value.state.status === "terminal") writes.push(write);
					else
						writes.push({
							type: "task.sidecar",
							id: write.value.id,
							ordinal: append(fileName("task", write.value.id), { type: "task", value: write.value }),
						});
					break;
				case "document.create":
					writes.push({
						type: write.type,
						record: write.record,
						ordinal: append(fileName("doc", write.record.id), {
							type: "document",
							id: write.record.id,
							content: write.content,
						}),
					});
					break;
				case "document.change":
					writes.push({
						type: write.type,
						id: write.id,
						ordinal: append(fileName("doc", write.id), { type: "document", id: write.id, content: write.content }),
					});
					break;
			}
		}
		return { marker: encodeLine({ format: 1, type: "commit", seq: pending.seq, writes }), sidecars: files };
	}
	#replacements(writes: PreparedMemoryCommit["writes"], encoded: Encoded): Map<string, string> {
		const created = new Set<DocumentId>();
		const retired = new Set<DocumentId>();
		const bases = new Set<DocumentId>();
		const tasks = new Map<TaskId, StoredTask>();
		for (const write of writes) {
			if (write.type === "document.create" && currentOnly(write.record)) created.add(write.record.id);
			else if (write.type === "document.retire") retired.add(write.id);
			else if (write.type === "document.change" && write.content.kind === "base") bases.add(write.id);
			else if (write.type === "task") tasks.set(write.value.id, write.value);
		}
		const result = new Map<string, string>();
		const isCurrentOnly = (id: DocumentId): boolean => this.#currentOnly.has(id) || created.has(id);
		for (const id of retired) if (isCurrentOnly(id)) result.set(fileName("doc", id), "");
		for (const id of bases) {
			const file = fileName("doc", id);
			const content = encoded.sidecars.get(file);
			if (isCurrentOnly(id) && !retired.has(id) && content !== undefined) result.set(file, content);
		}
		for (const [id, task] of tasks) {
			const file = fileName("task", id);
			if (task.state.status === "terminal" && (this.#liveTasks.has(id) || encoded.sidecars.has(file)))
				result.set(file, "");
		}
		return result;
	}
	async #reclaim(replacements: ReadonlyMap<string, string>, context: Context): Promise<void> {
		if (replacements.size === 0) return;
		if (this.fsync && !(await this.fs.flushFile(this.mainPath, context)).ok) return;
		for (const [file, content] of replacements) {
			const path = await this.fs.joinPath([this.directory, file], context);
			if (!path.ok) continue;
			if (content === "") {
				await this.fs.remove(path.value, { force: true }, context);
				continue;
			}
			const temporary = await this.fs.joinPath([this.directory, `${file}.reclaim`], context);
			if (!temporary.ok || !(await this.fs.writeFile(temporary.value, content, context)).ok) continue;
			if (this.fsync && !(await this.fs.flushFile(temporary.value, context)).ok) continue;
			await this.fs.renameFile(temporary.value, path.value, context);
		}
	}
	async #read<Value>(
		path: string,
		file: string,
		context: Context,
		parse: (text: string, line: number) => Value,
	): Promise<FileLines<Value>> {
		const read = await this.fs.readBinaryFile(path, context);
		if (!read.ok) {
			if (read.error.code === "not_found") return { path, lines: [] };
			throw fileError(`read of ${file}`, read.error);
		}
		const bytes = read.value;
		const complete = bytes.length === 0 || bytes.at(-1) === 10 ? bytes.length : bytes.lastIndexOf(10) + 1;
		if (complete !== bytes.length) {
			const truncated = await this.fs.truncateFile(path, complete, context);
			if (!truncated.ok) throw fileError(`torn-line truncation of ${file}`, truncated.error);
		}
		const lines: Line<Value>[] = [];
		let start = 0;
		for (let end = 0; end < complete; end++) {
			if (bytes[end] !== 10) continue;
			let text: string;
			try {
				text = decoder.decode(bytes.subarray(start, end));
			} catch (cause) {
				throw new JsonlCorruptionError(
					`Invalid UTF-8 in complete ${file} line ${lines.length + 1}`,
					cause instanceof Error ? cause : undefined,
				);
			}
			lines.push({ value: parse(text, lines.length + 1), start });
			start = end + 1;
		}
		return { path, lines };
	}
	async #recover(context: Context): Promise<void> {
		const main = await this.#read(this.mainPath, "main.jsonl", context, parseMarker);
		let previous = 0;
		for (const { value } of main.lines) {
			if (value.seq <= previous)
				throw new JsonlCorruptionError("Commit sequence does not strictly increase in main.jsonl");
			previous = value.seq;
		}
		const listed = await this.fs.listDir(this.directory, context);
		if (!listed.ok) throw fileError("directory listing", listed.error);
		for (const item of listed.value)
			if (item.kind === "file" && /^(?:doc|task)-(?:0|[1-9]\d*)\.jsonl\.reclaim$/.test(item.name))
				await this.fs.remove(item.path, { force: true }, context);
		const files = new Map<string, FileLines<Sidecar>>();
		const records = new Map<string, Sidecar>();
		const names = listed.value
			.filter((item) => item.kind === "file" && /^(?:doc|task)-(?:0|[1-9]\d*)\.jsonl$/.test(item.name))
			.map((item) => item.name)
			.sort();
		for (const file of names) {
			const parsed = await this.#read(await this.#path(file, context), file, context, (text, line) =>
				parseSidecar(text, file, line),
			);
			let prior: Sidecar | undefined;
			for (const { value } of parsed.lines) {
				if (prior && (value.seq < prior.seq || (value.seq === prior.seq && value.ordinal <= prior.ordinal)))
					throw new JsonlCorruptionError(`Sidecar records are out of order in ${file}`);
				records.set(recordKey(file, value.seq, value.ordinal), value);
				prior = value;
			}
			files.set(file, parsed);
		}
		const retired = new Set<DocumentId>();
		const terminal = new Set<TaskId>();
		for (const { value: marker } of main.lines)
			for (const write of marker.writes) {
				if (write.type === "document.create" && currentOnly(write.record)) this.#currentOnly.add(write.record.id);
				else if (write.type === "document.retire") retired.add(write.id);
				else if (write.type === "task") {
					terminal.add(write.value.id);
					this.#liveTasks.delete(write.value.id);
				} else if (write.type === "task.sidecar") {
					terminal.delete(write.id);
					this.#liveTasks.add(write.id);
				}
			}
		const bases = new Map<DocumentId, Sidecar>();
		for (const { value: marker } of main.lines)
			for (const write of marker.writes) {
				if (write.type !== "document.create" && write.type !== "document.change") continue;
				const id = write.type === "document.create" ? write.record.id : write.id;
				const record = records.get(recordKey(fileName("doc", id), marker.seq, write.ordinal));
				if (
					this.#currentOnly.has(id) &&
					record?.payload.type === "document" &&
					record.payload.id === id &&
					record.payload.content.kind === "base"
				) {
					const previous = bases.get(id);
					if (previous === undefined || before(previous.seq, previous.ordinal, record)) bases.set(id, record);
				}
			}
		const confirmed = new Set<string>();
		const confirm = (marker: Marker, ordinal: number, file: string, optional: boolean): Sidecar | undefined => {
			const key = recordKey(file, marker.seq, ordinal);
			if (confirmed.has(key)) throw new JsonlCorruptionError("Sidecar record is confirmed more than once");
			const record = records.get(key);
			if (record) confirmed.add(key);
			else if (!optional)
				throw new JsonlCorruptionError(`Missing confirmed sidecar record ${file} at sequence ${marker.seq}`);
			return record;
		};
		for (const { value: marker } of main.lines) {
			const writes: StorageWrite[] = [];
			for (const write of marker.writes) {
				if (write.type === "task.sidecar") {
					const record = confirm(marker, write.ordinal, fileName("task", write.id), terminal.has(write.id));
					if (record) {
						if (record.payload.type !== "task" || record.payload.value.id !== write.id)
							throw new JsonlCorruptionError(`Confirmed task sidecar data does not match commit ${marker.seq}`);
						if (!terminal.has(write.id)) writes.push({ type: "task", value: record.payload.value });
					}
				} else if (write.type === "document.create" || write.type === "document.change") {
					const id = write.type === "document.create" ? write.record.id : write.id;
					const reclaimed =
						(this.#currentOnly.has(id) && retired.has(id)) || before(marker.seq, write.ordinal, bases.get(id));
					const record = confirm(marker, write.ordinal, fileName("doc", id), reclaimed);
					let content: DocumentContent | undefined;
					if (record) {
						if (record.payload.type !== "document" || record.payload.id !== id)
							throw new JsonlCorruptionError(`Confirmed document sidecar data does not match commit ${marker.seq}`);
						content = record.payload.content;
					}
					if (write.type === "document.create") {
						if (content && content.kind !== "base")
							throw new JsonlCorruptionError(`Document creation lacks a confirmed base in commit ${marker.seq}`);
						writes.push({
							type: "document.create",
							record: write.record,
							content: reclaimed || content === undefined ? { kind: "base", version: 1, value: {} } : content,
						});
					} else if (!reclaimed && content) writes.push({ type: "document.change", id, content });
				} else writes.push(write);
			}
			try {
				this.#memory.prepareCommit(writes, marker.seq).apply();
			} catch (cause) {
				throw new JsonlCorruptionError(
					`Invalid committed state at sequence ${marker.seq}`,
					cause instanceof Error ? cause : undefined,
				);
			}
		}
		const replacements = new Map<string, string>();
		for (const [file, parsed] of files) {
			let unconfirmedAt: number | undefined;
			const kept: Line<Sidecar>[] = [];
			for (const line of parsed.lines) {
				if (confirmed.has(recordKey(file, line.value.seq, line.value.ordinal))) {
					if (unconfirmedAt !== undefined)
						throw new JsonlCorruptionError(`Confirmed record follows an unconfirmed tail in ${file}`);
					kept.push(line);
				} else unconfirmedAt ??= line.start;
			}
			if (unconfirmedAt !== undefined) {
				const result = await this.fs.truncateFile(parsed.path, unconfirmedAt, context);
				if (!result.ok) throw fileError(`tail truncation of ${file}`, result.error);
			}
			const numericId = Number(file.slice(file.indexOf("-") + 1, -6));
			let retained: readonly Line<Sidecar>[] | undefined;
			if (file.startsWith("task-") && terminal.has(idFromNumber<TaskId>(numericId))) retained = [];
			else if (file.startsWith("doc-")) {
				const id = idFromNumber<DocumentId>(numericId);
				if (this.#currentOnly.has(id) && retired.has(id)) retained = [];
				else if (bases.has(id)) retained = kept.filter(({ value }) => !before(value.seq, value.ordinal, bases.get(id)));
			}
			if (retained && (retained.length === 0 || retained.length < kept.length))
				replacements.set(file, retained.map((line) => encodeLine(line.value)).join(""));
		}
		await this.#reclaim(replacements, context);
	}

	mintId: Storage["mintId"] = async () => this.#view.mintId();
	conversation: Storage["conversation"] = async (...args) => this.#view.conversation(...args);
	scanConversations: Storage["scanConversations"] = async (...args) => this.#view.scanConversations(...args);
	entry(id: EntryId, context: Context): ReturnType<Storage["entry"]>;
	entry(conversationId: ConversationId, id: EntryId, context: Context): ReturnType<Storage["entry"]>;
	async entry(id: EntryId | ConversationId, next: EntryId | Context, context?: Context): ReturnType<Storage["entry"]> {
		const memory = this.#view;
		if (context === undefined) return memory.entry(idFromNumber<EntryId>(id), next as Context);
		if (typeof next !== "number") throw new StorageRequestError("Storage.entry() requires an entry ID");
		return memory.entry(idFromNumber<ConversationId>(id), next, context);
	}
	findLatestHeadMarker: Storage["findLatestHeadMarker"] = async (...args) => this.#view.findLatestHeadMarker(...args);
	scanEntries: Storage["scanEntries"] = async (...args) => this.#view.scanEntries(...args);
	task: Storage["task"] = async (...args) => this.#view.task(...args);
	scanTasks: Storage["scanTasks"] = async (...args) => this.#view.scanTasks(...args);
	submission: Storage["submission"] = async (...args) => this.#view.submission(...args);
	scanSubmissions: Storage["scanSubmissions"] = async (...args) => this.#view.scanSubmissions(...args);
	submissionByRequest: Storage["submissionByRequest"] = async (...args) => this.#view.submissionByRequest(...args);
	findDocument: Storage["findDocument"] = async (...args) => this.#view.findDocument(...args);
	document: Storage["document"] = async (...args) => this.#view.document(...args);
	scanDocuments: Storage["scanDocuments"] = async (...args) => this.#view.scanDocuments(...args);
	async close(context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#memory.close(context);
	}
}
