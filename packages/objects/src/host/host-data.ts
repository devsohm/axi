import { awaitWithContext, type Context, withoutAbortSignal } from "../context/index.ts";
import type { Address } from "../contracts/index.ts";
import { kindOfKey } from "../contracts/host-kind.ts";
import { invalid } from "../data/internal.ts";
import type { ObjectsError } from "../data/index.ts";
import type { ChangedDocument, Documents, KeyedSlot } from "../documents/internal.ts";
import type { Batch } from "../state/internal.ts";
import {
	deleteHostData,
	type HostCommit,
	type HostDataCounts,
	type HostImportOptions,
	hostDataOwners,
	importHostData,
	readHostArchive,
	tablesToMigrate,
} from "../store/host-data.ts";
import type { LiveQueries, LiveQuery } from "../store/live-query.ts";
import type { StagedWrite } from "../store/step.ts";
import type { ObjectsStore } from "../store/store.ts";
import type { TableDefinition } from "../store/table.ts";
import { storedText } from "../store/text.ts";

export class HostDataGate {
	#tail: Promise<void> = Promise.resolve();
	#readers = 0;
	#exclusive = false;
	#waiting: (() => void)[] = [];
	#drained: (() => void) | undefined;
	enter(): Promise<void> | undefined {
		if (!this.#exclusive) {
			this.#readers++;
			return;
		}
		return (async () => {
			while (this.#exclusive) await new Promise<void>((resolve) => this.#waiting.push(resolve));
			this.#readers++;
		})();
	}
	leave(): void {
		if (--this.#readers === 0) this.#drained?.();
	}
	async turn<T>(
		work: (exclusive: <R>(run: () => Promise<R>) => Promise<R>) => Promise<T>,
		context: Context,
	): Promise<T> {
		const previous = this.#tail,
			done = Promise.withResolvers<void>();
		this.#tail = previous.then(() => done.promise);
		try {
			await awaitWithContext(previous, context);
			return await work(async (run) => {
				this.#exclusive = true;
				try {
					if (this.#readers > 0)
						await awaitWithContext(
							new Promise<void>((resolve) => {
								this.#drained = resolve;
							}),
							context,
						);
					return await run();
				} finally {
					this.#exclusive = false;
					this.#drained = undefined;
					for (const ready of this.#waiting.splice(0)) ready();
				}
			});
		} finally {
			// A cancelled waiter must not let later operations overtake an earlier operation still running.
			void previous.then(done.resolve);
		}
	}
}

export type HostDataObject = {
	readonly identity: string;
	readonly owner: string;
	readonly documents: Documents;
	readonly liveQueries: LiveQueries;
	declaredTable(table: string): TableDefinition | undefined;
};
export type HostDataSite = {
	readonly store: ObjectsStore;
	readonly batch: Batch;
	readonly gate: HostDataGate;
	objects(): Iterable<HostDataObject>;
	activate(owner: string, context: Context): Promise<(() => void) | undefined>;
};
const ownerOf = (table: string) => table.slice(0, table.indexOf(":"));

export async function importInto(
	site: HostDataSite,
	parts: AsyncIterable<unknown> | Iterable<unknown>,
	context: Context,
	options: HostImportOptions,
): Promise<HostDataCounts> {
	const archive = await readHostArchive(parts, context),
		target = options.address === undefined ? archive.host : storedText(options.address.key, "importHostData: address");
	const existing = options.existing ?? "refuse";
	return site.gate.turn(async (exclusive) => {
		const activated = new Map<string, () => void>();
		try {
			for (;;) {
				const section = await exclusive(async () => {
					const histories = new Map<string, TableDefinition>();
					const migrating = tablesToMigrate(site.store, archive);
					for (const object of site.objects())
						for (const table of migrating) {
							const definition = object.declaredTable(table);
							if (definition) histories.set(table, definition);
						}
					const missing = migrating.filter((table) => !histories.has(table));
					if (missing.length) return { kind: "activate", owners: new Set(missing.map(ownerOf)) } as const;
					const owners = await hostDataOwners(site.store, target, archive, context);
					const counts = await coordinated(site, owners, target, context, (commit) =>
						importHostData(
							site.store,
							archive,
							{ target, existing, histories },
							commit,
							context,
						),
					);
					return { kind: "done", counts } as const;
				});
				if (section.kind === "done") return section.counts;
				for (const owner of section.owners) {
					const release = activated.has(owner) ? undefined : await site.activate(owner, context);
					if (release === undefined)
						throw invalid("args", `importHostData: ${owner} is not served here to migrate its tables`);
					activated.set(owner, release);
				}
			}
		} finally {
			for (const release of activated.values()) release();
		}
	}, context);
}

export function deleteFrom(site: HostDataSite, address: Address, context: Context): Promise<HostDataCounts> {
	const key = storedText(address.key, "deleteHostData: address");
	return site.gate.turn(
		(exclusive) =>
			exclusive(async () => {
				const owners = await hostDataOwners(site.store, key, undefined, context);
				return coordinated(site, owners, key, context, (commit) => deleteHostData(site.store, key, commit, context));
			}),
		context,
	);
}

async function coordinated<T>(
	site: HostDataSite,
	owners: ReadonlySet<string>,
	key: string,
	context: Context,
	change: (commit: HostCommit) => Promise<T>,
): Promise<T> {
	const kind = kindOfKey(key),
		releases: (() => void)[] = [];
	const objects = [...site.objects()]
		.filter((object) => owners.has(object.owner) || object.documents.hostSlots(kind).length > 0)
		.sort((a, b) => (a.identity < b.identity ? -1 : 1));
	try {
		for (const object of objects) {
			const pending = object.documents.line.acquire();
			try {
				releases.push(await awaitWithContext(pending, context));
			} catch (error) {
				void pending.then((release) => release());
				throw error;
			}
		}
		const slots: { slot: KeyedSlot; changed: ChangedDocument }[] = objects.flatMap((object) =>
			object.documents
				.hostSlots(kind)
				.filter((slot) => slot.holds(key))
				.map((slot) => ({ slot, changed: { kind: "unchanged" } })),
		);
		const queries: { query: LiveQuery; result?: Awaited<ReturnType<LiveQuery["rerun"]>> }[] = objects.flatMap(
			(object) => object.liveQueries.onHostKind(kind).map((query) => ({ query })),
		);
		const quiet = withoutAbortSignal(context);
		const after: StagedWrite = {
			order: "write",
			apply: async (step) => {
				for (const read of slots) read.changed = await read.slot.readChanged(key, step, quiet);
				for (const read of queries) read.result = await read.query.rerun(step, quiet);
				return [];
			},
		};
		return await change({
			after: [after],
			fence: {
				admit: () => context.abortSignal?.aborted !== true,
				adopt: () => {
					const failures: [KeyedSlot, ObjectsError][] = [];
					// Reads include this commit's writes; publication waits for COMMIT and changes every owner in one batch.
					site.batch.commit(() => {
						for (const { slot, changed } of slots) {
							slot.adoptChanged(key, changed);
							if (changed.kind === "failed") failures.push([slot, changed.error]);
						}
						for (const { query, result } of queries) query.adopt(result!);
					}, quiet);
					for (const [slot, error] of failures) slot.owner.fail(error);
				},
			},
		});
	} finally {
		for (const release of releases) release();
	}
}
