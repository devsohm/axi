import { awaitWithContext, type Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { SqliteValue } from "../../sqlite/index.ts";
import { ObjectsError } from "../data/index.ts";
import { ARCHIVE_FORMAT, type ArchivePart } from "./archive.ts";
import type { TableRecord } from "./catalog.ts";
import { listRecords, listRevisions } from "./engine.ts";
import { ROW_VERSION, versionColumn, type Scalar } from "./rows.ts";
import { STORE_SCHEMA } from "./schema.ts";
import { quote, recordedPut } from "./sql.ts";
import type { ObjectsStore } from "./store.ts";

export const EXPORT_PAGE = 100;
export class StoreExport implements AsyncIterableIterator<ArchivePart> {
	readonly #context: Context;
	#iterator: AsyncGenerator<ArchivePart> | undefined;
	#state: "active" | "aborted" | "closed" | "done" = "active";
	#release: (() => void) | undefined;
	readonly #abort = (): void => this.#finish("aborted");
	constructor(store: ObjectsStore, context: Context) {
		this.#context = context;
		this.#iterator = parts(
			store,
			context,
			(release) => {
				if (this.#state !== "active") release();
				else {
					this.#release = release;
					context.abortSignal?.addEventListener("abort", this.#abort, {
						once: true,
					});
				}
			},
			() => this.#finish("closed"),
		);
	}
	[Symbol.asyncIterator](): this {
		return this;
	}
	async next(): Promise<IteratorResult<ArchivePart>> {
		if (this.#context.abortSignal?.aborted) this.#finish("aborted");
		this.#check();
		if (!this.#iterator) return { done: true, value: undefined };
		let value: IteratorResult<ArchivePart>;
		try {
			const pending = this.#iterator.next();
			value = await (this.#release
				? pending
				: awaitWithContext(pending, this.#context));
		} catch (error) {
			if (this.#context.abortSignal?.aborted) this.#finish("aborted");
			this.#check();
			this.#finish("done");
			throw error;
		}
		this.#check();
		if (value.done) this.#finish("done");
		return value;
	}
	async return(): Promise<IteratorResult<ArchivePart>> {
		this.#finish("done");
		return { done: true, value: undefined };
	}
	#finish(state: "aborted" | "closed" | "done"): void {
		if (this.#state !== "active") return;
		this.#state = state;
		this.#release?.();
		this.#release = undefined;
		this.#context.abortSignal?.removeEventListener("abort", this.#abort);
		const iterator = this.#iterator;
		this.#iterator = undefined;
		void iterator?.return(undefined).catch(() => {});
	}
	#check(): void {
		if (this.#state === "aborted")
			throw new ObjectsError(
				{ code: "aborted", message: "store: export aborted" },
				{ cause: this.#context.abortSignal?.reason },
			);
		if (this.#state === "closed")
			throw new ObjectsError({
				code: "released",
				reason: "closed",
				message: "store: closed",
			});
	}
}
async function* parts(
	store: ObjectsStore,
	context: Context,
	hold: (release: () => void) => void,
	close: () => void,
): AsyncGenerator<ArchivePart> {
	const release = await store.take(close);
	hold(release);
	try {
		if (context.abortSignal?.aborted)
			throw new ObjectsError(
				{ code: "aborted", message: "store: export aborted" },
				{ cause: context.abortSignal.reason },
			);
		yield {
			kind: "manifest",
			format: ARCHIVE_FORMAT,
			schema: STORE_SCHEMA,
			lastSeq: store.lastSeq,
			nextId: store.nextId,
		};
		let writes = 0;
		for (const record of [...store.tables.values()].sort((a, b) =>
			a.table < b.table ? -1 : 1,
		)) {
			const { indexes, ...table } = record;
			yield { kind: "table", ...table };
			writes++;
			const key = record.key.map(quote).join(", "),
				columns = recordedPut(record.table, record.columns)
					.physical.map(quote)
					.join(", ");
			let after: SqliteValue[] | undefined;
			for (;;) {
				const filter =
					after === undefined
						? ""
						: ` WHERE (${key}) > (${after.map(() => "?").join(", ")})`;
				const rows = await store.read(
					(executor) =>
						executor.all<Record<string, SqliteValue>>(
							`SELECT ${columns} FROM ${quote(record.table)}${filter} ORDER BY ${key} LIMIT ?`,
							...(after ?? []),
							EXPORT_PAGE,
						),
					context,
				);
				for (const stored of rows) {
					yield putOf(record, stored);
					writes++;
				}
				if (rows.length < EXPORT_PAGE) break;
				after = record.key.map((name) => rows.at(-1)![name]!);
			}
			for (const [name, columns] of Object.entries(indexes)) {
				yield { kind: "index", table: record.table, name, columns };
				writes++;
			}
		}
		let lastId = 0;
		for (;;) {
			const documents = await store.read(
				(executor) => listRecords(executor, lastId, EXPORT_PAGE),
				context,
			);
			for (const record of documents) {
				yield { kind: "document.create", record };
				writes++;
				let lastSeq = 0;
				for (;;) {
					const revisions = await store.read(
						(executor) =>
							listRevisions(executor, record.id, lastSeq, EXPORT_PAGE),
						context,
					);
					for (const revision of revisions) {
						yield { kind: "document.revision", ...revision };
						writes++;
					}
					if (revisions.length < EXPORT_PAGE) break;
					lastSeq = revisions.at(-1)!.seq;
				}
			}
			if (documents.length < EXPORT_PAGE) break;
			lastId = documents.at(-1)!.id;
		}
		yield { kind: "end", writes };
	} finally {
		release();
	}
}
function putOf(
	record: TableRecord,
	stored: Readonly<Record<string, SqliteValue>>,
): Extract<ArchivePart, { readonly kind: "put" }> {
	const row: Record<string, Scalar | JsonValue> = {},
		versions: Record<string, number> = {};
	for (const [name, column] of Object.entries(record.columns)) {
		const value = stored[name];
		if (value == null) continue;
		if (column.type === "json") {
			row[name] = JSON.parse(value as string) as JsonValue;
			versions[name] = stored[versionColumn(name)] as number;
		} else row[name] = column.type === "bool" ? value === 1 : (value as Scalar);
	}
	return {
		kind: "put",
		table: record.table,
		row,
		version: stored[ROW_VERSION] as number,
		columns: versions,
	};
}
