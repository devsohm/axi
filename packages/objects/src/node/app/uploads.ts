import { mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { ObjectsError } from "../../data/index.ts";
import { invalid } from "../../data/internal.ts";
import { newToken } from "./secrets.ts";
type Upload<T> = {
	data: T;
	handle: FileHandle;
	size: number;
	touched: number;
	writes: Set<Promise<unknown>>;
	failed: boolean;
	closing?: Promise<void>;
};
export type Finished<T> = { readonly data: T; readonly size: number };
export class Uploads<T> {
	readonly #directory: string;
	readonly #max: number;
	readonly #pending = new Map<string, Upload<T>>();
	constructor(run: string, max: number) {
		this.#directory = run;
		this.#max = max;
	}
	get size(): number {
		return [...this.#pending.values()].reduce((sum, upload) => sum + upload.size, 0);
	}
	find(matches: (data: T) => boolean): string | undefined {
		for (const [id, upload] of this.#pending) if (matches(upload.data)) return id;
		return undefined;
	}
	async begin(data: T): Promise<string> {
		if (this.#pending.size >= this.#max)
			throw new ObjectsError({
				code: "unavailable",
				reason: "busy",
				message: `files: ${this.#max} uploads are under way; finish one, or wait for an idle one to expire`,
			});
		const id = newToken(12);
		await mkdir(this.#directory, { recursive: true, mode: 0o700 });
		const handle = await open(join(this.#directory, id), "wx", 0o600);
		this.#pending.set(id, { data, handle, size: 0, touched: Date.now(), writes: new Set(), failed: false });
		return id;
	}
	#find(id: string): Upload<T> {
		const upload = this.#pending.get(id);
		if (!upload) throw invalid("args", `files: no upload ${id} (finished, failed, expired or unknown)`);
		return upload;
	}
	#close(upload: Upload<T>): Promise<void> {
		return (upload.closing ??= Promise.allSettled([...upload.writes]).then(() => upload.handle.close()));
	}
	async append(
		id: string,
		offset: number,
		bytes: Uint8Array,
		room: (adding: number, fileSize: number) => void,
	): Promise<void> {
		const upload = this.#find(id);
		if (offset !== upload.size)
			throw invalid("args", `files: upload ${id} is at offset ${upload.size}, not ${offset}`, { offset: upload.size });
		room(bytes.length, offset + bytes.length);
		upload.size += bytes.length;
		upload.touched = Date.now();
		const write = upload.handle.write(bytes, 0, bytes.length, offset);
		upload.writes.add(write);
		try {
			await write;
		} catch (error) {
			upload.writes.delete(write);
			if (!upload.failed) {
				upload.failed = true;
				this.#pending.delete(id);
				await this.#close(upload);
				await rm(join(this.#directory, id), { force: true });
			}
			throw error;
		}
		upload.writes.delete(write);
	}
	async uploaded(id: string): Promise<number> {
		const upload = this.#find(id);
		await Promise.allSettled([...upload.writes]);
		if (upload.failed) throw invalid("args", `files: upload ${id} failed to write and was dropped`);
		return upload.size;
	}
	async finish(id: string, path: string): Promise<Finished<T>> {
		const upload = this.#find(id);
		this.#pending.delete(id);
		await this.#close(upload);
		if (upload.failed) throw invalid("args", `files: upload ${id} failed to write and was dropped`);
		await rename(join(this.#directory, id), path);
		return { data: upload.data, size: upload.size };
	}
	async cancel(id: string): Promise<void> {
		const upload = this.#pending.get(id);
		if (upload) await this.#discard(id, upload);
	}
	async #discard(id: string, upload: Upload<T>): Promise<void> {
		this.#pending.delete(id);
		await this.#close(upload);
		await rm(join(this.#directory, id), { force: true });
	}
	async expire(idleMs: number): Promise<void> {
		const now = Date.now();
		for (const [id, upload] of this.#pending) if (now - upload.touched >= idleMs) await this.#discard(id, upload);
	}
	async close(): Promise<void> {
		for (const [id, upload] of this.#pending) await this.#discard(id, upload);
	}
}
