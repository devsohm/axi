import type { Context } from "../context/index.ts";
import { invalid } from "../data/internal.ts";
import { IdAllocator } from "./allocator.ts";
import { applyWrite, Diverged } from "./applier.ts";
import { checkWrite } from "./archive.ts";
import { writeCatalog, type TableRecord } from "./catalog.ts";
import { OUTBOX_FORMAT, type OutboxCommit } from "./outbox.ts";
import { TABLES } from "./schema.ts";
import { Step } from "./step.ts";
import type { ObjectsStore } from "./store.ts";

export async function applyBatch(
	store: ObjectsStore,
	commits: readonly OutboxCommit[],
	context: Context,
): Promise<void> {
	const checked = commits.map((commit, index) => {
		const label = `batch: commit ${index}`;
		if (
			!Number.isSafeInteger(commit.seq) ||
			!Number.isSafeInteger(commit.nextId) ||
			!Array.isArray(commit.writes)
		)
			throw invalid("args", `${label}: not an outbox commit`);
		return {
			seq: commit.seq,
			nextId: commit.nextId,
			writes: commit.writes.map((write, i) =>
				checkWrite(write, `${label}: write ${i}`, context),
			),
		};
	});
	await store.replay(
		async (executor, catalog) => {
			const known = new Map(catalog),
				changed = new Map<string, TableRecord>();
			let lastSeq = store.lastSeq,
				nextId = store.nextId;
			for (const [i, commit] of checked.entries()) {
				const label = `batch: commit ${i} (seq ${commit.seq})`;
				if (commit.seq !== lastSeq + 1)
					throw invalid("args", `${label}: does not follow seq ${lastSeq}`);
				if (commit.nextId < nextId)
					throw invalid(
						"args",
						`${label}: its next id ${commit.nextId} is below ${nextId}`,
					);
				const step = new Step(
					executor,
					commit.seq,
					new IdAllocator(commit.nextId),
					known,
				);
				for (const [j, write] of commit.writes.entries()) {
					const at = `${label}: write ${j} (${write.kind})`;
					if (
						write.kind === "document.create" &&
						write.record.id >= commit.nextId &&
						!(
							commit.nextId === Number.MAX_SAFE_INTEGER &&
							write.record.id === commit.nextId
						)
					)
						throw invalid(
							"args",
							`${at}: id ${write.record.id} is not below the commit's next id ${commit.nextId}`,
						);
					await applyWrite(step, write, at);
				}
				await writeCatalog(step);
				for (const [name, table] of step.tables) {
					known.set(name, table);
					changed.set(name, table);
				}
				if (store.recordsOutbox)
					await executor.run(
						`INSERT INTO ${TABLES.outbox} (seq, format, next_id, writes) VALUES (?, ?, ?, ?)`,
						commit.seq,
						OUTBOX_FORMAT,
						commit.nextId,
						JSON.stringify(commit.writes),
					);
				lastSeq = commit.seq;
				nextId = commit.nextId;
			}
			await executor.run(
				`UPDATE ${TABLES.meta} SET last_seq = ?, next_id = ? WHERE singleton = 1`,
				lastSeq,
				nextId,
			);
			return { lastSeq, nextId, tables: changed };
		},
		(error) => error instanceof Diverged,
	);
}
