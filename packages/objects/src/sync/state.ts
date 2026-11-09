import type { Context } from "../context/index.ts";
import type { SyncState, SyncStateStore } from "./client.ts";
import { type SyncFileSystem, isNotFound, unwrap } from "./files.ts";
import { checkSessionId } from "./filesystem.ts";

export class FileSyncStateStore implements SyncStateStore {
	readonly #fs: SyncFileSystem;
	readonly #directory: string;
	constructor(fs: SyncFileSystem, directory: string) {
		this.#fs = fs;
		this.#directory = directory;
	}
	async #path(id: string, suffix: string, context: Context): Promise<string> {
		return unwrap(await this.#fs.joinPath([this.#directory, checkSessionId(id) + suffix], context));
	}
	async get(id: string, context: Context): Promise<SyncState | undefined> {
		const result = await this.#fs.readTextFile(await this.#path(id, ".json", context), context);
		if (isNotFound(result)) return undefined;
		const state: SyncState = JSON.parse(unwrap(result));
		return { syncedHead: state.syncedHead, ...(state.pulling === undefined ? {} : { pulling: state.pulling }) };
	}
	async set(id: string, state: SyncState, context: Context): Promise<void> {
		unwrap(await this.#fs.createDir(this.#directory, { recursive: true }, context));
		const temp = await this.#path(id, ".json.tmp", context);
		unwrap(await this.#fs.writeFile(temp, JSON.stringify(state), context));
		unwrap(await this.#fs.renameFile(temp, await this.#path(id, ".json", context), context));
	}
	async delete(id: string, context: Context): Promise<void> {
		unwrap(await this.#fs.remove(await this.#path(id, ".json", context), { force: true }, context));
	}
}
