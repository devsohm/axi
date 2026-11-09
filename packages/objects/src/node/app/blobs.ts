import { constants } from "node:fs";
import { copyFile, link, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export class Blobs {
	readonly dir: string;
	constructor(dir: string) {
		this.dir = dir;
	}
	path(id: string): string {
		return join(this.dir, id);
	}
	async prepare(): Promise<void> {
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
	}
	async write(id: string, bytes: Uint8Array, staging: string): Promise<void> {
		await this.prepare();
		await mkdir(dirname(staging), { recursive: true, mode: 0o700 });
		await writeFile(staging, bytes, { flag: "wx", mode: 0o600 });
		await rename(staging, this.path(id));
	}
	async read(id: string, size: number, offset: number, length: number): Promise<Uint8Array> {
		const file = await open(this.path(id), "r");
		try {
			const output = new Uint8Array(Math.max(0, Math.min(size - offset, length)));
			const read = await file.read(output, 0, output.length, offset);
			return output.subarray(0, read.bytesRead);
		} finally {
			await file.close();
		}
	}
	async remove(ids: readonly string[]): Promise<void> {
		for (const id of ids) await rm(this.path(id), { force: true });
	}
	async sweep(known: (id: string) => Promise<boolean>): Promise<void> {
		const files = await readdir(this.dir).catch(() => []);
		for (const file of files) if (!(await known(file))) await this.remove([file]);
	}
	async linkInto(id: string, target: string): Promise<void> {
		try {
			await link(this.path(id), join(target, id));
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") throw error;
			await copyFile(this.path(id), join(target, id), constants.COPYFILE_EXCL);
		}
	}
}
