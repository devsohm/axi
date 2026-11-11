import { objectsMetrics } from "../telemetry.ts";
import type { Context } from "../context/index.ts";
import type { KindShape } from "../contracts/index.ts";
import { kindOfKey } from "../contracts/host-kind.ts";
import type { Op, Prepared } from "../delta/index.ts";
import {
	changeDocument,
	createDocument,
	findDocument,
	listDocumentKeys,
	loadDocument,
	retireDocument,
	type DocumentAddress,
	type DocumentContent,
	type StoredDocument,
} from "../store/engine.ts";
import type { StagedWrite } from "../store/step.ts";
import type { ObjectsStore } from "../store/store.ts";
import type { JsonObject, KeyedBy, StateDefinition } from "./definition.ts";

type Definition = StateDefinition<JsonObject, KeyedBy, boolean>;
export type Stored = {
	readonly id: number;
	readonly revision: number;
	readonly version: number;
	readonly deltasSinceBase: number;
};
export type FoundDocument = {
	readonly stored: Stored;
	readonly fingerprint: string;
	readonly host: string | undefined;
};
export type Loaded = { readonly value: JsonObject; readonly stored: Stored };
export type DocumentChange = {
	readonly prepared: Prepared<JsonObject> | undefined;
	readonly retires: boolean;
};
export type Held = { readonly ops: readonly Op[]; readonly base: boolean };
export type StoredChange =
	| { readonly kind: "retire" }
	| {
			readonly kind: "create";
			readonly version: number;
			readonly created: { id: number };
	  }
	| { readonly kind: "change"; readonly stored: Stored }
	| {
			readonly kind: "held";
			readonly stored: Stored;
			readonly withinMs: number;
	  };

export function checkReadable(
	stored: { readonly version: number; readonly fingerprint: string },
	definition: Definition,
): void {
	if (stored.version > definition.version)
		throw new Error(
			`${definition.name}: stored at version ${stored.version}, newer than the code's ${definition.version}`,
		);
	if (
		stored.version === definition.version &&
		stored.fingerprint !== definition.fingerprint
	)
		throw new Error(
			`${definition.name}: stored with another schema at version ${definition.version} (a schema changed without a bump)`,
		);
}
export function storedAfter(change: StoredChange): Stored | undefined {
	if (change.kind === "retire") return undefined;
	if (change.kind === "create")
		return {
			id: change.created.id,
			revision: 1,
			version: change.version,
			deltasSinceBase: 0,
		};
	return change.stored;
}

export class Persistence {
	readonly store: ObjectsStore;
	readonly #scope: Omit<DocumentAddress, "key">;
	readonly #host: KindShape | undefined;
	constructor(store: ObjectsStore, owner: string, namespace: string, kind: string, host?: KindShape) {
		this.store = store;
		this.#scope = { owner, namespace, kind };
		this.#host = host;
	}
	at(key: string): DocumentAddress {
		return key ? { ...this.#scope, key } : this.#scope;
	}
	async read(
		key: string,
		context: Context,
	): Promise<StoredDocument | undefined> {
		const document = await this.store.read(async (db) => {
			const record = await findDocument(db, this.at(key));
			return record === undefined ? undefined : loadDocument(db, record);
		}, context);
		if (document)
			objectsMetrics(context.telemetry.metrics).counter("objects.store.loads").add(1);
		return document;
	}
	decode(
		document: StoredDocument,
		definition: Definition,
		context: Context,
	): Loaded {
		const { record, deltasSinceBase } = document;
		this.checkHost(record.host, definition);
		checkReadable(record, definition);
		// These records contain the JSON object accepted when the document was written.
		const previous = document.value as JsonObject;
		return {
			value:
				record.version === definition.version
					? previous
					: definition.migrate(previous, record.version, context),
			stored: {
				id: record.id,
				revision: record.revision,
				version: record.version,
				deltasSinceBase,
			},
		};
	}
	checkHost(host: string | undefined, definition: Definition): void {
		if ((host !== undefined) === (this.#host !== undefined)) return;
		const stored = host === undefined ? "string keys" : `addresses of ${kindOfKey(host)}`;
		const declared = this.#host === undefined ? "string keys" : `addresses of ${this.#host.kind}`;
		throw new Error(`${definition.name}: stored with ${stored}, declared with ${declared} (convert it explicitly)`);
	}
	async find(
		key: string,
		context: Context,
	): Promise<FoundDocument | undefined> {
		const record = await this.store.read(
			(db) => findDocument(db, this.at(key)),
			context,
		);
		return record === undefined
			? undefined
			: {
					stored: {
						id: record.id,
						revision: record.revision,
						version: record.version,
						deltasSinceBase: 0,
					},
					fingerprint: record.fingerprint,
					host: record.host,
				};
	}
	keys(
		after: string | undefined,
		limit: number,
		context: Context,
	): Promise<string[]> {
		return this.store.read(
			(db) => listDocumentKeys(db, this.#scope, after, limit),
			context,
		);
	}
	stage(
		key: string,
		definition: Definition,
		stored: Stored | undefined,
		change: DocumentChange,
		writes: StagedWrite[],
		held?: Held,
	): StoredChange {
		if (change.retires && stored)
			writes.push(retireDocument(stored.id, stored.revision));
		const prepared = change.prepared;
		if (!prepared) return { kind: "retire" };
		const { version, fingerprint } = definition;
		if (!stored || change.retires) {
			const created = { id: 0 };
			const base = { version, fingerprint, value: prepared.value };
			writes.push(
				createDocument(
					{ ...this.at(key), ...(this.#host === undefined ? {} : { host: key }) },
					base,
					JSON.stringify(prepared.value),
					(id) => {
						created.id = id;
					},
				),
			);
			return { kind: "create", version, created };
		}
		const checkpoint =
			held?.base === true ||
			stored.version !== version ||
			definition.checkpointWhen(prepared.value, prepared.ops, {
				deltasSinceBase: stored.deltasSinceBase,
			});
		const ops = held ? [...held.ops, ...prepared.ops] : prepared.ops;
		const content: DocumentContent = checkpoint
			? { kind: "base", value: prepared.value, version, fingerprint }
			: { kind: "delta", version, ops };
		writes.push(
			changeDocument(
				stored.id,
				stored.revision,
				content,
				JSON.stringify(checkpoint ? prepared.value : ops),
			),
		);
		return {
			kind: "change",
			stored: {
				id: stored.id,
				revision: stored.revision + 1,
				version,
				deltasSinceBase: checkpoint ? 0 : stored.deltasSinceBase + 1,
			},
		};
	}
}
