import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { encodeJsonl, hostKind, openStore, sqliteBackend, str } from "../src/index.ts";
import { startServer, type AppError, type AppOptions } from "../src/node/app/index.ts";
import { ARCHIVE_FORMAT, packData } from "../src/node/app/archive.ts";
import { workerDirectory } from "../src/node/app/layout.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";

type Principal = { readonly kind: "owner" | "server" | "worker" };
function options(directory: string, errors: AppError[]) {
	return {
		name: "archive-app",
		dataDir: join(directory, "data"),
		root: join(directory, "plugins"),
		api: { name: "@example/api", versions: ["v1"], modules: {} },
		kinds: { server: { platform: "node" }, worker: { platform: "node" } },
		principal: { server: { kind: "server" }, owner: { kind: "owner" }, worker: () => ({ kind: "worker" }) },
		onError: (error) => errors.push(error),
	} satisfies AppOptions<Principal>;
}

test("the app exports dormant worker data and imports it under the worker lock", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-app-worker-data-"));
	await mkdir(join(directory, "plugins"));
	const errors: AppError[] = [];
	const Notebook = hostKind("notebook", { name: str() });
	const app = await startServer<Principal>(
		{
			...options(directory, errors),
			workers: [
				{
					kind: Notebook,
					entry: fileURLToPath(new URL("./fixtures/runtime-worker.ts", import.meta.url)),
					authorize: () => true,
					start: () => null,
				},
			],
		},
		context,
	);
	try {
		const source = Notebook({ name: "source" }),
			target = Notebook({ name: "restored" });
		const data = workerDirectory(app.dataDir, source);
		await mkdir(join(data, "files"), { recursive: true });
		const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(data, "store.sqlite"))), context);
		await store.close(context);
		await writeFile(join(data, "files", "saved.txt"), "persisted worker file");
		const archive = join(directory, "worker.tar");
		await app.exportData(source, archive, context);
		await app.importData(archive, target, context);
		const restored = workerDirectory(app.dataDir, target);
		expect(await readFile(join(restored, "files", "saved.txt"), "utf8")).toBe("persisted worker file");
		expect((await stat(join(restored, "store.sqlite"))).isFile()).toBe(true);
		await expect(app.importData(archive, target, context)).rejects.toThrow("exists already");
		await writeFile(join(restored, "files", "saved.txt"), "old replacement");
		await app.importData(archive, target, context, { existing: "replace" });
		expect(await readFile(join(restored, "files", "saved.txt"), "utf8")).toBe("persisted worker file");
		await app.deleteData(target, context);
		await expect(stat(restored)).rejects.toMatchObject({ code: "ENOENT" });
		await app.deleteData(target, context);
		expect(app.workers.get(Notebook.kind)?.state.value[source.key]).toBeUndefined();
		expect(app.web).toBeUndefined();
		expect(app.tui).toBeUndefined();
		await expect(app.exportData({ kind: "unknown", key: "unknown", params: {} }, archive, context)).rejects.toThrow(
			'no worker kind "unknown"',
		);
		await expect(app.importData(archive, { kind: "unknown", key: "unknown", params: {} }, context)).rejects.toThrow(
			'no worker kind "unknown"',
		);
		await app.basesBuilt;
		await app.baseWatched;
		expect(errors).toEqual([]);
	} finally {
		await app.close(context);
		await rm(directory, { recursive: true, force: true });
	}
}, 15000);

test.each(["wrong-app", "wrong-format"] as const)(
	"a %s worker archive is rejected and a later valid import still works",
	async (invalid) => {
		const directory = await mkdtemp(join(tmpdir(), "axi-app-archive-check-"));
		await mkdir(join(directory, "plugins"));
		const errors: AppError[] = [];
		const Notebook = hostKind("notebook", { name: str() });
		const app = await startServer<Principal>(
			{
				...options(directory, errors),
				workers: [
					{
						kind: Notebook,
						entry: fileURLToPath(new URL("./fixtures/runtime-worker.ts", import.meta.url)),
						authorize: () => true,
						start: () => null,
					},
				],
			},
			context,
		);
		try {
			const source = Notebook({ name: "source" }),
				target = Notebook({ name: "restored" });
			const data = workerDirectory(app.dataDir, source),
				archive = join(directory, "worker.tar");
			await mkdir(join(data, "files"), { recursive: true });
			const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(data, "store.sqlite"))), context);
			await store.close(context);
			const manifest = {
				format: invalid === "wrong-format" ? ARCHIVE_FORMAT + 1 : ARCHIVE_FORMAT,
				app: invalid === "wrong-app" ? "another-app" : "archive-app",
				api: "v1",
				address: { kind: source.kind, key: source.key },
			};
			const server = join(directory, "server.jsonl"), chunks: Uint8Array[] = [];
			for await (const chunk of encodeJsonl(app.host.exportHostData(source, context))) chunks.push(chunk);
			await writeFile(server, Buffer.concat(chunks));
			await packData(data, manifest, server, archive, context);
			await expect(app.importData(archive, target, context)).rejects.toThrow(
				invalid === "wrong-app" ? 'an archive of "another-app"' : "not a format",
			);
			await expect(stat(workerDirectory(app.dataDir, target))).rejects.toMatchObject({ code: "ENOENT" });
			await app.exportData(source, archive, context);
			await app.importData(archive, target, context);
			expect((await stat(join(workerDirectory(app.dataDir, target), "store.sqlite"))).isFile()).toBe(true);
			await app.basesBuilt;
			expect(errors).toEqual([]);
		} finally {
			await app.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	},
	15000,
);

test("a second app cannot use an active data directory and an idempotent close permits reopening", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-app-exclusive-"));
	await mkdir(join(directory, "plugins"));
	const errors: AppError[] = [],
		config = options(directory, errors);
	const first = await startServer<Principal>(config, context);
	try {
		await expect(startServer<Principal>(config, context)).rejects.toThrow("another server runs on");
		const close = first.close(context);
		expect(first.close(context)).toBe(close);
		await close;
		const reopened = await startServer<Principal>(config, context);
		await reopened.close(context);
		expect(errors).toEqual([]);
	} finally {
		await first.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});
