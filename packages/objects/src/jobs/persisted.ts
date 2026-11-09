import type { Context } from "../context/index.ts";
import type { JsonObject } from "../documents/index.ts";
import type { Persistence, Stored } from "../documents/internal.ts";
import { changeDocument, createDocument, retireDocument } from "../store/engine.ts";
import type { StagedWrite } from "../store/step.ts";
import { RUN_RECORD, recordOf, type StoredRun } from "./stored.ts";

export type LoadedRecord = {
	readonly id: string;
	readonly record: StoredRun;
	readonly stored: Stored;
};
export class PersistedRuns {
	readonly #records: Persistence;
	readonly #states: Persistence;
	readonly #stored = new Map<string, Stored>();
	readonly #blockedStates = new Map<string, Stored>();
	constructor(records: Persistence, states: Persistence) {
		this.#records = records;
		this.#states = states;
	}
	stage(id: string, record: StoredRun, writes: StagedWrite[]): () => void {
		const text = JSON.stringify(record),
			stored = this.#stored.get(id),
			value = record as unknown as JsonObject;
		const { version, fingerprint } = RUN_RECORD;
		if (stored) {
			writes.push(changeDocument(stored.id, stored.revision, { kind: "base", version, fingerprint, value }, text));
			return () => {
				this.#stored.set(id, { ...stored, revision: stored.revision + 1 });
			};
		}
		const created = { id: 0 };
		writes.push(
			createDocument(this.#records.at(id), { version, fingerprint, value }, text, (id) => {
				created.id = id;
			}),
		);
		return () => {
			this.#stored.set(id, {
				id: created.id,
				revision: 1,
				version,
				deltasSinceBase: 0,
			});
		};
	}
	stageRetire(id: string, writes: StagedWrite[]): () => void {
		const record = this.#stored.get(id),
			state = this.#blockedStates.get(id);
		if (record) writes.push(retireDocument(record.id, record.revision));
		if (state) writes.push(retireDocument(state.id, state.revision));
		return () => {
			this.#stored.delete(id);
			this.#blockedStates.delete(id);
		};
	}
	async findBlockedState(id: string, context: Context): Promise<void> {
		const found = await this.#states.find(id, context);
		if (found) this.#blockedStates.set(id, found.stored);
	}
	forgetBlockedState(id: string): void {
		this.#blockedStates.delete(id);
	}
	async load(context: Context): Promise<LoadedRecord[]> {
		const loaded: LoadedRecord[] = [];
		let after: string | undefined;
		for (;;) {
			const keys = await this.#records.keys(after, 100, context);
			for (const id of keys) {
				const document = await this.#records.read(id, context);
				if (!document) continue;
				const { record, value, deltasSinceBase } = document;
				const stored = {
					id: record.id,
					revision: record.revision,
					version: record.version,
					deltasSinceBase,
				};
				this.#stored.set(id, stored);
				loaded.push({ id, record: recordOf(value as JsonObject), stored });
			}
			if (keys.length < 100) return loaded;
			after = keys.at(-1);
		}
	}
	drop(): void {
		this.#stored.clear();
		this.#blockedStates.clear();
	}
}
