import type { Context } from "../context/index.ts";
import type { SyncBody } from "./batch.ts";
import { isNotFound, unwrap, type SyncFileSystem } from "./files.ts";
import {
	remoteHead,
	type BatchInfo,
	type JsonObject,
	type PutBatchResult,
	type RemoteListing,
	type Seq,
	type SessionChanges,
	type SessionSyncMaintenance,
} from "./remote.ts";

const sessionName = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const numberName = (value: number) => String(value).padStart(16, "0");
const bodyOf = (value: unknown): SyncBody => {
	// Capture metadata before filesystem waits let the caller change it.
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	return (async function* () {
		yield bytes;
	})();
};
export function checkSessionId(sessionId: string): string {
	if (sessionName.test(sessionId)) return sessionId;
	throw new Error(`Invalid session ID for a sync directory: ${sessionId}`);
}
export class FileSystemSyncRemote implements SessionSyncMaintenance {
	readonly #fs: SyncFileSystem;
	readonly #root: string;
	constructor(fs: SyncFileSystem, root: string) {
		this.#fs = fs;
		this.#root = root;
	}
	async #path(id: string, context: Context, ...parts: string[]): Promise<string> {
		return unwrap(await this.#fs.joinPath([this.#root, checkSessionId(id), ...parts], context));
	}
	async #json<T>(id: string, context: Context, ...parts: string[]): Promise<T | undefined> {
		const result = await this.#fs.readBinaryFile(await this.#path(id, context, ...parts), context);
		return isNotFound(result) ? undefined : JSON.parse(new TextDecoder().decode(unwrap(result)));
	}
	async #write(id: string, context: Context, parts: readonly string[], name: string, body: SyncBody): Promise<void> {
		unwrap(await this.#fs.createDir(await this.#path(id, context, ...parts), { recursive: true }, context));
		const file = await this.#path(id, context, ...parts, name);
		const temp = await this.#path(id, context, ...parts, name + ".tmp");
		unwrap(await this.#fs.writeFile(temp, new Uint8Array(), context));
		try {
			for await (const chunk of body) unwrap(await this.#fs.appendFile(temp, chunk, context));
		} catch (error) {
			await this.#fs.remove(temp, { force: true }, context);
			throw error;
		}
		unwrap(await this.#fs.renameFile(temp, file, context));
	}
	async #stream(id: string, context: Context, ...parts: string[]): Promise<SyncBody | undefined> {
		const result = await this.#fs.openBinaryReader(await this.#path(id, context, ...parts), undefined, context);
		if (isNotFound(result)) return undefined;
		const reader = unwrap(result);
		return (async function* () {
			try {
				let offset = 0;
				for (;;) {
					const bytes = unwrap(await reader.read(offset, 256 * 1024, context));
					if (!bytes.length) return;
					offset += bytes.length;
					yield bytes;
				}
			} finally {
				await reader.close(context);
			}
		})();
	}
	async #names(id: string, context: Context, ...parts: string[]): Promise<string[]> {
		const result = await this.#fs.listDir(await this.#path(id, context, ...parts), context);
		return isNotFound(result) ? [] : unwrap(result).map((entry) => entry.name);
	}
	async putBatch(
		id: string,
		after: Seq,
		to: Seq,
		device: string,
		body: SyncBody,
		context: Context,
		options: { readonly archive?: boolean } = {},
	): Promise<PutBatchResult> {
		const name = numberName(after);
		const existing = await this.#json<BatchInfo>(id, context, "slots", name + ".json");
		if (existing) return { type: "exists", to: existing.to, device: existing.device };
		const head = remoteHead(await this.list(id, context));
		if (after !== head) return { type: "not_head", head };
		await this.#write(id, context, ["batches"], name + ".batch", body);
		await this.#write(
			id,
			context,
			["slots"],
			name + ".json",
			bodyOf({ after, to, device, ...(options.archive === true ? { archive: true } : {}) }),
		);
		return { type: "created" };
	}
	async getBatch(id: string, after: Seq, context: Context): Promise<SyncBody | undefined> {
		const slot = await this.#json<BatchInfo>(id, context, "slots", numberName(after) + ".json");
		return slot && !slot.folded ? this.#stream(id, context, "batches", numberName(after) + ".batch") : undefined;
	}
	getSnapshot(id: string, to: Seq, context: Context): Promise<SyncBody | undefined> {
		return this.#stream(id, context, "snapshots", numberName(to) + ".batch");
	}
	putSnapshot(id: string, to: Seq, body: SyncBody, context: Context): Promise<void> {
		return this.#write(id, context, ["snapshots"], numberName(to) + ".batch", body);
	}
	async foldBatches(id: string, afters: readonly Seq[], context: Context): Promise<void> {
		for (const after of afters) {
			const name = numberName(after);
			const slot = await this.#json<BatchInfo>(id, context, "slots", name + ".json");
			if (!slot || slot.folded) continue;
			await this.#write(id, context, ["slots"], name + ".json", bodyOf({ ...slot, folded: true }));
			unwrap(
				await this.#fs.remove(await this.#path(id, context, "batches", name + ".batch"), { force: true }, context),
			);
		}
	}
	async deleteSnapshots(id: string, snapshots: readonly Seq[], context: Context): Promise<void> {
		for (const sequence of snapshots)
			unwrap(
				await this.#fs.remove(
					await this.#path(id, context, "snapshots", numberName(sequence) + ".batch"),
					{ force: true },
					context,
				),
			);
	}
	async list(id: string, context: Context): Promise<RemoteListing> {
		const batches: BatchInfo[] = [],
			snapshots: Seq[] = [];
		for (const name of await this.#names(id, context, "slots")) {
			if (!/^\d{16}\.json$/.test(name)) continue;
			const info = await this.#json<BatchInfo>(id, context, "slots", name);
			if (info) batches.push(info);
		}
		for (const name of await this.#names(id, context, "snapshots"))
			if (/^\d{16}\.batch$/.test(name)) snapshots.push(Number(name.slice(0, 16)));
		return { batches, snapshots };
	}
	async sessions(_cursor: string | undefined, context: Context): Promise<SessionChanges> {
		const result = await this.#fs.listDir(this.#root, context);
		const names = isNotFound(result)
			? []
			: unwrap(result)
					.filter((item) => item.kind === "directory" && sessionName.test(item.name))
					.map((item) => item.name)
					.sort();
		const sessions = [];
		for (const id of names)
			sessions.push({ id, head: remoteHead(await this.list(id, context)), meta: await this.getMeta(id, context) });
		return { sessions, cursor: "", more: false };
	}
	async putMeta(id: string, meta: JsonObject, context: Context): Promise<void> {
		return this.#write(id, context, [], "meta.json", bodyOf(meta));
	}
	getMeta(id: string, context: Context): Promise<JsonObject | undefined> {
		return this.#json(id, context, "meta.json");
	}
}
