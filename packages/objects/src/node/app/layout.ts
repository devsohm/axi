import { createHash } from "node:crypto";
import { chmod, mkdir, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse } from "node:path";
import type { Address } from "../../contracts/index.ts";
export type AppLayout = {
	readonly dataDir: string;
	readonly server: string;
	readonly serverStore: string;
	readonly workers: string;
	readonly plugins: string;
	readonly logs: string;
	readonly workerBases: string;
	readonly compileCache: string;
	readonly ownerToken: string;
	readonly cookieSecret: string;
};
export function defaultDataDir(name: string): string {
	return join(homedir(), "." + name);
}
export async function openDataDir(path: string): Promise<string> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const actual = await realpath(path),
		home = await realpath(homedir());
	if (actual === home || actual === parse(actual).root)
		throw new Error(
			`startServer: the data directory ${actual} is ${actual === home ? "the home directory" : "a file system's root"}; name a directory of the app's own`,
		);
	const owner = (await stat(actual)).uid;
	if (process.getuid && owner !== process.getuid())
		throw new Error(`startServer: the data directory ${actual} belongs to another user (uid ${owner})`);
	return actual;
}
export async function privateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700);
}
export async function createLayout(dataDir: string): Promise<AppLayout> {
	const server = join(dataDir, "server"),
		workers = join(dataDir, "workers"),
		plugins = join(dataDir, "plugins"),
		logs = join(dataDir, "logs"),
		cache = join(dataDir, "cache"),
		workerBases = join(cache, "workers"),
		compileCache = join(cache, "node");
	for (const directory of [dataDir, server, workers, plugins, logs, cache, workerBases, compileCache])
		await privateDirectory(directory);
	return {
		dataDir,
		server,
		workers,
		plugins,
		logs,
		workerBases,
		compileCache,
		serverStore: join(server, "store.sqlite"),
		ownerToken: join(dataDir, "owner-token"),
		cookieSecret: join(server, "cookie-secret"),
	};
}
export async function privateStore(path: string): Promise<void> {
	const file = await open(path, "a", 0o600);
	await file.close();
	for (const suffix of ["", "-wal", "-shm"])
		try {
			await chmod(path + suffix, 0o600);
		} catch (error) {
			if (!(error && typeof error === "object" && Reflect.get(error, "code") === "ENOENT")) throw error;
		}
}
export function workerDirectory(dataDir: string, address: Address): string {
	const escaped = encodeURIComponent(address.key).replace(/%[0-9A-F]{2}|[.!'()*~A-Z]/g, (part) =>
		part.startsWith("%") ? part : "%" + part.charCodeAt(0).toString(16).toUpperCase(),
	);
	return join(
		dataDir,
		"workers",
		address.kind,
		escaped.length <= 160 ? escaped : "sha256-" + createHash("sha256").update(address.key).digest("hex"),
	);
}
