import { mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { arr, bytes, int, local, map, method, num, obj, str } from "../../contracts/index.ts";
import { ObjectsError, type Principal } from "../../data/index.ts";
import { invalid } from "../../data/internal.ts";
import { defineState } from "../../documents/index.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import { newToken } from "./secrets.ts";
import { Uploads } from "./uploads.ts";
export type FileInfo = {
	readonly id: string;
	readonly name: string;
	readonly mime: string;
	readonly size: number;
	readonly created: number;
};
export type FilesCaps = { readonly maxFile?: number; readonly maxTotal?: number };
const Entry = obj({ name: str(), mime: str(), size: int(), created: num() });
export const Files = local("objects.app.files", {
	version: 1,
	params: {},
	members: {
		list: arr(obj({ id: str(), ...Entry.properties })),
		put: method(obj({ name: str(), mime: str(), bytes: bytes() }), str()),
		begin: method(obj({ name: str(), mime: str() }), str()),
		append: method(obj({ upload: str(), offset: int({ min: 0 }), bytes: bytes() })),
		uploaded: method(str(), int()),
		finish: method(str(), str()),
		read: method(obj({ id: str(), offset: int({ min: 0 }), length: int({ min: 0 }) }), bytes()),
		remove: method(str()),
	},
});
const Index = defineState("objects.app.files", {
	version: 1,
	schema: obj({ files: map(Entry) }),
	persist: true,
	initial: () => ({ files: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});
const piece = 4 * 1024 * 1024;
const tooLarge = (message: string) => new ObjectsError({ code: "too_large", message: "files: " + message });
export function filesFacet<P extends Principal>(dir: string, caps: FilesCaps = {}, uploads = 64): Facet<P> {
	return defineFacet<P>((host) =>
		host.serve(Files, (_params, self) => {
			const index = self.state(Index),
				uploadsDir = join(dir, ".uploads"),
				run = join(uploadsDir, newToken(12)),
				pending = new Uploads(run, uploads);
			const room = (adding: number, fileSize: number): void => {
				if (fileSize > (caps.maxFile ?? 256 * 1024 * 1024))
					throw tooLarge(
						`a file of ${fileSize} bytes is larger than this host's cap (${caps.maxFile ?? 256 * 1024 * 1024})`,
					);
				const total =
					Object.values(index.value.files).reduce((sum, file) => sum + file.size, 0) + pending.size + adding;
				if (total > (caps.maxTotal ?? 4 * 1024 ** 3))
					throw tooLarge(`this host's files would exceed their cap (${caps.maxTotal ?? 4 * 1024 ** 3} bytes)`);
			};
			const has = (id: string): boolean => Object.hasOwn(index.value.files, id);
			self.onLive(async (ctx) => {
				for (const child of await readdir(uploadsDir).catch(() => []))
					if (join(uploadsDir, child) !== run) await rm(join(uploadsDir, child), { recursive: true, force: true });
				try {
					for (;;) {
						await delay(60_000, undefined, { signal: ctx.abortSignal });
						await pending.expire(60 * 60_000);
					}
				} finally {
					if (ctx.abortSignal?.aborted) await pending.close();
				}
			});
			return {
				list: self.derive([index], ([value]) => Object.entries(value.files).map(([id, file]) => ({ id, ...file }))),
				put: async ({ name, mime, bytes }, context) => {
					if (bytes.length > piece) throw tooLarge(`put takes at most ${piece} bytes: use begin, append, finish`);
					room(bytes.length, bytes.length);
					const id = newToken(12);
					await mkdir(dir, { recursive: true, mode: 0o700 });
					await writeFile(join(dir, id), bytes, { mode: 0o600 });
					await index.change((draft) => {
						draft.files[id] = { name, mime, size: bytes.length, created: Date.now() };
					}, context);
					return id;
				},
				begin: ({ name, mime }) => pending.begin(name, mime),
				append: async ({ upload, offset, bytes }) => {
					if (bytes.length > piece) throw tooLarge(`append takes at most ${piece} bytes`);
					await pending.append(upload, offset, bytes, room);
					return null;
				},
				uploaded: (id) => pending.uploaded(id),
				finish: async (upload, context) => {
					const id = newToken(12);
					await mkdir(dir, { recursive: true, mode: 0o700 });
					const file = await pending.finish(upload, join(dir, id));
					await index.change((draft) => {
						draft.files[id] = { ...file, created: Date.now() };
					}, context);
					return id;
				},
				read: async ({ id, offset, length }) => {
					if (!has(id)) throw invalid("args", `files: no file ${id}`);
					if (length > piece) throw tooLarge(`read takes at most ${piece} bytes`);
					const file = await open(join(dir, id), "r");
					try {
						const data = new Uint8Array(Math.max(0, Math.min(length, index.value.files[id]!.size - offset))),
							{ bytesRead } = await file.read(data, 0, data.length, offset);
						return data.subarray(0, bytesRead);
					} finally {
						await file.close();
					}
				},
				remove: async (id, context) => {
					if (has(id)) {
						await index.change((draft) => {
							delete draft.files[id];
						}, context);
						await rm(join(dir, id), { force: true });
					}
					return null;
				},
			};
		}),
	);
}
