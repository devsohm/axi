import { awaitWithContext, type Context } from "../context/index.ts";
import type { SqliteDatabase, SqliteExecutor } from "../sqlite/index.ts";
import { ObjectsError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import { IdAllocator } from "./allocator.ts";
import { applyWrite } from "./applier.ts";
import {
	ARCHIVE_FORMAT,
	checkPart,
	type ArchiveManifest,
	type ArchivePart,
} from "./archive.ts";
import type { Backend } from "./backend.ts";
import { readCatalog, writeCatalog } from "./catalog.ts";
import type { DocumentRecord } from "./engine.ts";
import {
	applyStoreSchema,
	STORE_SCHEMA,
	TABLES,
	type MetaRow,
} from "./schema.ts";
import { Step } from "./step.ts";
import { ObjectsStore, type Store, type StoreOptions } from "./store.ts";
import { storedText } from "./text.ts";

export async function importStore(
	backend: Backend,
	parts: AsyncIterable<unknown> | Iterable<unknown>,
	context: Context,
	options: StoreOptions = {},
): Promise<Store> {
	const { db } = backend;
	try {
		context.abortSignal?.throwIfAborted();
		if (
			await db.get("SELECT name FROM sqlite_master WHERE name = ?", TABLES.meta)
		)
			throw invalid("args", "import: the backend holds a store already");
		const meta = await db.transaction(async (executor) => {
			const metadata = await applyStoreSchema(inTransaction(executor)),
				input = new ImportArchive(executor, context);
			await each(parts, context, (part) => input.take(part));
			return input.finish(metadata, options.outbox === true);
		});
		return new ObjectsStore(db, meta, await readCatalog(db));
	} catch (error) {
		try {
			await db.close();
		} catch {}
		throw error;
	}
}
function inTransaction(executor: SqliteExecutor): SqliteDatabase {
	return {
		exec: (sql) => executor.exec(sql),
		run: (sql, ...params) => executor.run(sql, ...params),
		runCounted: (sql, ...params) => executor.runCounted(sql, ...params),
		get: (sql, ...params) => executor.get(sql, ...params),
		all: (sql, ...params) => executor.all(sql, ...params),
		transaction: (work) => work(executor),
		close: async () => {
			throw new Error("import: the backend closes after the import");
		},
	};
}
type Phase =
	| { readonly kind: "manifest" }
	| { readonly kind: "puts" | "indexes"; readonly table: string }
	| { readonly kind: "documents" | "ended" };
class ImportArchive {
	readonly #executor: SqliteExecutor;
	readonly #context: Context;
	readonly #tables = new Set<string>();
	readonly #ids = new Set<number>();
	readonly #lives = new Map<string, [number, number][]>();
	#manifest: ArchiveManifest | undefined;
	#step: Step | undefined;
	#phase: Phase = { kind: "manifest" };
	#document:
		| {
				readonly record: DocumentRecord;
				lastSeq: number;
				base: number | undefined;
		  }
		| undefined;
	#position = 0;
	#writes = 0;
	constructor(executor: SqliteExecutor, context: Context) {
		this.#executor = executor;
		this.#context = context;
	}
	async take(value: unknown): Promise<void> {
		const position = this.#position++,
			part = checkPart(value, position, this.#context),
			what = `import: part ${position} (${part.kind})`;
		const refuse = (message: string): never => {
			throw invalid("args", `${what}: ${message}`);
		};
		if (this.#phase.kind === "ended") refuse("after the end");
		if (!this.#step || part.kind === "manifest") {
			if (part.kind !== "manifest" || this.#step)
				return refuse("the manifest comes first, once");
			if (part.format !== ARCHIVE_FORMAT)
				refuse(`format ${part.format} is not ${ARCHIVE_FORMAT}`);
			if (part.schema > STORE_SCHEMA)
				refuse(`schema ${part.schema} is newer than ${STORE_SCHEMA}`);
			if (part.host !== undefined) refuse(`a host's data archive (${part.host}); import it with importHostData`);
			this.#manifest = part;
			this.#step = new Step(
				this.#executor,
				part.lastSeq,
				new IdAllocator(part.nextId),
				new Map(),
			);
			return;
		}
		if (part.kind === "end") {
			if (part.writes !== this.#writes)
				refuse(`counts ${part.writes} writes, the archive has ${this.#writes}`);
			this.#finishDocument(what);
			this.#phase = { kind: "ended" };
			return;
		}
		switch (part.kind) {
			case "table":
				if (this.#phase.kind === "documents")
					refuse("tables come before the documents");
				if (this.#tables.has(part.table))
					refuse(`table ${part.table} occurs twice`);
				this.#tables.add(part.table);
				this.#phase = { kind: "puts", table: part.table };
				break;
			case "put":
				if (this.#phase.kind !== "puts" || this.#phase.table !== part.table)
					refuse("a put follows its table's table write, before its indexes");
				break;
			case "index":
				if (
					(this.#phase.kind !== "puts" && this.#phase.kind !== "indexes") ||
					this.#phase.table !== part.table
				)
					refuse("an index follows its table's table write and puts");
				this.#phase = { kind: "indexes", table: part.table };
				break;
			case "document.create":
				this.#newDocument(part.record, what);
				this.#phase = { kind: "documents" };
				break;
			case "document.revision":
				this.#revision(part, what);
				this.#phase = { kind: "documents" };
				break;
		}
		this.#writes++;
		await applyWrite(this.#step, part, what);
	}
	#newDocument(record: DocumentRecord, what: string): void {
		this.#finishDocument(what);
		const refuse = (message: string): never => {
			throw invalid("args", `${what}: ${message}`);
		};
		const manifest = this.#manifest!;
		if (
			record.id >= manifest.nextId &&
			!(record.id === Number.MAX_SAFE_INTEGER && record.id === manifest.nextId)
		)
			refuse(`id ${record.id} is not below ${manifest.nextId}`);
		if (this.#ids.has(record.id)) refuse(`id ${record.id} occurs twice`);
		if (
			record.createdAt > manifest.lastSeq ||
			(record.retiredAt !== undefined &&
				(record.retiredAt < record.createdAt ||
					record.retiredAt > manifest.lastSeq))
		)
			refuse("a lifetime outside the manifest's lastSeq");
		for (const text of [
			record.owner,
			record.namespace,
			record.kind,
			record.key ?? "",
			...(record.host === undefined ? [] : [record.host]),
		])
			if (storedText(text, what) !== text)
				refuse("an address is not well-formed text");
		if (
			record.meta !== undefined &&
			storedText(record.meta, what) !== record.meta
		)
			refuse("the meta is not well-formed text");
		const address = JSON.stringify([
				record.owner,
				record.namespace,
				record.kind,
				record.key ?? "",
			]),
			past = this.#lives.get(address) ?? [];
		const from = record.createdAt,
			to = record.retiredAt ?? Infinity;
		if (from < to && past.some(([a, b]) => a < to && from < b))
			refuse("a second record at one address for an overlapping lifetime");
		past.push([from, to]);
		this.#lives.set(address, past);
		this.#ids.add(record.id);
		this.#document = { record, lastSeq: 0, base: undefined };
	}
	#revision(
		part: Extract<ArchivePart, { readonly kind: "document.revision" }>,
		what: string,
	): void {
		const document = this.#document;
		const refuse = (message: string): never => {
			throw invalid("args", `${what}: ${message}`);
		};
		if (!document || document.record.id !== part.id)
			return refuse("a revision follows its record's create");
		const { record } = document;
		if (record.retiredAt !== undefined && record.history !== "rewindable")
			refuse(`a retired ${record.history} record keeps no revisions`);
		if (
			part.seq <= document.lastSeq ||
			part.seq < record.createdAt ||
			part.seq > (record.retiredAt ?? this.#manifest!.lastSeq)
		)
			refuse("a revision out of seq order or outside its lifetime");
		if (part.content.kind === "base") document.base = part.content.version;
		else if (document.base !== part.content.version)
			refuse("a delta without a base at its version");
		document.lastSeq = part.seq;
	}
	#finishDocument(what: string): void {
		const document = this.#document;
		this.#document = undefined;
		if (!document) return;
		const contentless =
			document.record.history === "latest" &&
			document.record.retiredAt !== undefined;
		if (
			document.base === undefined
				? !contentless
				: document.base !== document.record.version
		)
			throw invalid(
				"args",
				`${what}: record ${document.record.id} has no base at its version`,
			);
	}
	async finish(meta: MetaRow, outbox: boolean): Promise<MetaRow> {
		if (this.#phase.kind !== "ended" || !this.#step || !this.#manifest)
			throw invalid("args", "import: the archive has no end part");
		const { lastSeq, nextId } = this.#manifest;
		await writeCatalog(this.#step);
		await this.#executor.run(
			`UPDATE ${TABLES.meta} SET last_seq = ?, next_id = ?, outbox = ?, outbox_floor = ? WHERE singleton = 1`,
			lastSeq,
			nextId,
			Number(outbox),
			lastSeq,
		);
		return {
			...meta,
			last_seq: lastSeq,
			next_id: nextId,
			outbox: Number(outbox),
			outbox_floor: lastSeq,
		};
	}
}
export async function each(
	parts: AsyncIterable<unknown> | Iterable<unknown>,
	context: Context,
	take: (part: unknown) => Promise<void>,
): Promise<void> {
	const iterator =
		Symbol.asyncIterator in parts
			? parts[Symbol.asyncIterator]()
			: parts[Symbol.iterator]();
	let complete = false;
	try {
		for (;;) {
			let item: IteratorResult<unknown>;
			try {
				item = await awaitWithContext(
					Promise.resolve(iterator.next()),
					context,
				);
			} catch (error) {
				if (context.abortSignal?.aborted)
					throw new ObjectsError(
						{ code: "aborted", message: "import: aborted" },
						{ cause: context.abortSignal.reason },
					);
				throw error;
			}
			if (item.done) {
				complete = true;
				return;
			}
			await take(item.value);
		}
	} finally {
		if (!complete) void Promise.resolve(iterator.return?.()).catch(() => {});
	}
}
