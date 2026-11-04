import type { Context } from "@axi/objects/context";
import {
	findDocument,
	insertDocument,
	readDocument,
	retireRecord,
	writeContent,
	type DocumentContent as EngineContent,
	type DocumentRecord as EngineRecord,
	type EncodedRow,
	type OwnerTable,
	type SeriesCommit,
	type StagedWrite,
	type Step,
	type StoreWrite,
} from "@axi/objects";
import type {
	DocumentContent,
	DocumentCopySource,
	DocumentCreate,
	DocumentId,
	Id,
	JsonObject,
	StorageWrite,
} from "../../types.ts";
import { StorageRequestError } from "../../errors.ts";
import { addressOf, durableRecord, engineRecord, readAt } from "./documents.ts";
import { conversationRow, entryRow, submissionRow, taskRow } from "./tables.ts";

export type RecordType = "conversation" | "entry" | "task" | "submission" | "document";
export type CommitTables = {
	readonly recordIds: OwnerTable;
	readonly conversations: OwnerTable;
	readonly entries: OwnerTable;
	readonly entryHeads: OwnerTable;
	readonly tasks: OwnerTable;
	readonly submissions: OwnerTable;
};
type RowWrite = {
	readonly id: number;
	readonly type: Exclude<RecordType, "document">;
	readonly table: OwnerTable;
	readonly row: EncodedRow;
};
type StagedBase = {
	readonly version: number;
	readonly value: JsonObject;
	readonly text: string;
};
type Command =
	| { readonly kind: "none" }
	| { readonly kind: "create"; readonly record: DocumentCreate }
	| {
			readonly kind: "copy";
			readonly record: DocumentCreate;
			readonly source: DocumentCopySource;
	  }
	| {
			readonly kind: "change";
			readonly content: DocumentContent;
			readonly text: string;
	  };
type Action = { command: Command; retire: boolean };
export class DurableCommit implements StagedWrite, SeriesCommit {
	readonly order = "write";
	readonly writes: readonly StagedWrite[] = [this];
	readonly #owner: string;
	readonly #tables: CommitTables;
	readonly #context: Context;
	readonly #claims: { id: number; type: RecordType }[] = [];
	readonly #rows: RowWrite[] = [];
	readonly #documents = new Map<DocumentId, Action>();
	readonly #bases = new Map<DocumentId, StagedBase>();
	#checked: { claimed: Map<number, RecordType>; documents: Map<DocumentId, EngineRecord> } | undefined;
	constructor(
		writes: readonly StorageWrite[],
		owner: string,
		tables: CommitTables,
		raise: (id: number) => void,
		context: Context,
	) {
		this.#owner = owner;
		this.#tables = tables;
		this.#context = context;
		for (const write of writes) this.#stage(write, raise);
	}
	#action(id: DocumentId): Action {
		let value = this.#documents.get(id);
		if (!value) {
			value = { command: { kind: "none" }, retire: false };
			this.#documents.set(id, value);
		}
		return value;
	}
	#row(id: Id<string>, type: RowWrite["type"], table: OwnerTable, value: object, raise: (id: number) => void): void {
		this.#claims.push({ id, type });
		this.#rows.push({ id, type, table, row: table.encode(value) });
		raise(id);
	}
	#stage(write: StorageWrite, raise: (id: number) => void): void {
		const tables = this.#tables;
		switch (write.type) {
			case "conversation":
				this.#row(write.value.id, write.type, tables.conversations, conversationRow(write.value), raise);
				return;
			case "task":
				this.#row(write.value.id, write.type, tables.tasks, taskRow(write.value), raise);
				return;
			case "submission":
				this.#row(write.value.id, write.type, tables.submissions, submissionRow(write.value), raise);
				return;
			case "entry":
				this.#row(write.value.id, write.type, tables.entries, entryRow(write.value), raise);
				if (write.value.head !== undefined)
					this.#rows.push({
						id: write.value.id,
						type: "entry",
						table: tables.entryHeads,
						row: tables.entryHeads.encode({
							id: write.value.id,
							conversation_id: write.value.conversationId,
						}),
					});
				return;
			case "document.create":
			case "document.copy": {
				const { id } = write.record,
					action = this.#action(id);
				if (action.command.kind !== "none") throw new Error(`Document ${id} has more than one content command`);
				if (write.type === "document.copy")
					action.command = {
						kind: "copy",
						record: write.record,
						source: write.source,
					};
				else {
					action.command = { kind: "create", record: write.record };
					this.#bases.set(id, {
						...write.content,
						text: JSON.stringify(write.content.value),
					});
				}
				this.#claims.push({ id, type: "document" });
				raise(id);
				return;
			}
			case "document.change": {
				const action = this.#action(write.id),
					{ content } = write;
				if (action.command.kind !== "none") throw new Error(`Document ${write.id} has more than one content command`);
				action.command = {
					kind: "change",
					content,
					text: JSON.stringify(content.kind === "base" ? content.value : content.ops),
				};
				return;
			}
			case "document.retire": {
				const action = this.#action(write.id);
				if (action.retire) throw new Error(`Document ${write.id} is retired more than once`);
				action.retire = true;
				return;
			}
		}
	}
	async check(step: Step): Promise<void> {
		const claimed = await this.#checkIds(step);
		const documents = await this.#checkDocuments(step);
		await this.#resolveCopies(step);
		this.#checked = { claimed, documents };
	}
	async #resolveCopies(step: Step): Promise<void> {
		for (const [id, { command }] of this.#documents)
			if (command.kind === "copy") {
				if (this.#documents.has(command.source.id))
					throw new Error(`Document copy ${id} source is changed in the copy batch`);
				try {
					const read = await readAt(step, command.source.id, command.source.at, this.#owner);
					if (read.kind === "current_only")
						throw new StorageRequestError(`Document ${read.id} does not retain historical content`);
					const stored = read.document;
					if (!stored) throw new Error(`Fork source document ${command.source.id} cannot be read`);
					const destination = command.record,
						source = stored.record;
					if (
						source.scope.kind !== "conversation" ||
						destination.scope.kind !== "conversation" ||
						source.kind !== destination.kind ||
						source.key !== destination.key ||
						source.history !== destination.history ||
						source.fork !== destination.fork
					)
						throw new Error(`Fork source document ${command.source.id} does not match the copied record`);
					this.#bases.set(id, {
						version: stored.version,
						value: stored.value,
						text: JSON.stringify(stored.value),
					});
				} catch (error) {
					throw new Error(`Document copy ${id} was rejected`, { cause: error });
				}
			}
	}
	async #checkIds(step: Step): Promise<Map<number, RecordType>> {
		const stored = new Map<number, RecordType | undefined>(),
			claimed = new Map<number, RecordType>();
		for (const { id, type } of this.#claims) {
			if (!stored.has(id))
				stored.set(
					id,
					(await this.#tables.recordIds.get(step, [id], this.#context))?.record_type as RecordType | undefined,
				);
			const owner = stored.get(id),
				prior = claimed.get(id),
				unique = type === "conversation" || type === "entry" || type === "document";
			if (owner !== undefined && (unique || owner !== type)) throw new Error(`ID ${id} already belongs to ${owner}`);
			if (prior !== undefined && unique) throw new Error(`ID ${id} is written more than once`);
			if (prior !== undefined && prior !== type) throw new Error(`ID ${id} is written as two record types`);
			claimed.set(id, type);
		}
		return new Map([...stored].filter((pair): pair is [number, RecordType] => pair[1] !== undefined));
	}
	async #checkDocuments(step: Step): Promise<Map<DocumentId, EngineRecord>> {
		const existing = new Map<DocumentId, EngineRecord>(),
			occupied = new Map<string, number>();
		for (const [id, action] of this.#documents) {
			if (action.command.kind === "create" || action.command.kind === "copy") continue;
			const engine = await readDocument(step, id),
				record = engine && durableRecord(engine, this.#owner);
			if (!record || !engine) throw new Error(`Unknown document: ${id}`);
			if (record.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			if (
				action.command.kind === "change" &&
				action.command.content.kind === "delta" &&
				action.command.content.version !== engine.version
			)
				throw new Error(`Document ${id} version transition requires a base`);
			existing.set(id, engine);
		}
		for (const { command, retire } of this.#documents.values())
			if (!retire && (command.kind === "create" || command.kind === "copy")) {
				const address = addressOf(command.record, this.#owner),
					key = JSON.stringify([address.namespace, address.kind, address.key]);
				let count = occupied.get(key);
				if (count === undefined) {
					const current = await findDocument(step, address);
					count = !current || this.#documents.get(current.id as DocumentId)?.retire ? 0 : 1;
				}
				count++;
				if (count > 1) throw new Error("Document address already has a current incarnation");
				occupied.set(key, count);
			}
		return existing;
	}
	#claim(step: Step, id: number, type: RecordType): Promise<StoreWrite> {
		const table = this.#tables.recordIds;
		return table.put(step, table.encode({ id, record_type: type }));
	}
	async apply(step: Step): Promise<readonly StoreWrite[]> {
		const writes: StoreWrite[] = [];
		const { claimed, documents } = this.#checked!;
		for (const row of this.#rows) {
			if (!claimed.has(row.id)) writes.push(await this.#claim(step, row.id, row.type));
			claimed.set(row.id, row.type);
			writes.push(await row.table.put(step, row.row, row.table === this.#tables.entries ? "commit_seq" : undefined));
		}
		for (const [id, record] of documents) {
			const action = this.#documents.get(id)!;
			let revision = record.revision;
			if (action.command.kind === "change") {
				const content: EngineContent =
					action.command.content.kind === "base"
						? { ...action.command.content, fingerprint: "" }
						: action.command.content;
				await writeContent(step, id, record.history, revision, content, action.command.text);
				writes.push({ kind: "document.change", id, revision, content });
				revision++;
			}
			if (action.retire) {
				await retireRecord(step, record);
				writes.push({ kind: "document.retire", id, revision });
			}
		}
		for (const [id, action] of this.#documents)
			if (action.command.kind === "create" || action.command.kind === "copy") {
				writes.push(await this.#claim(step, id, "document"));
				const base = this.#bases.get(id)!,
					record = engineRecord(action.command.record, this.#owner, base.version, step.seq, action.retire);
				await insertDocument(step, record, base.text);
				writes.push({
					kind: "document.create",
					record,
					base: { version: base.version, fingerprint: "", value: base.value },
				});
			}
		return writes;
	}
}
