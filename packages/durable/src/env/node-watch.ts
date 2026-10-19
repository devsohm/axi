import { createHash } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { lstat, readdir, readFile, stat, statfs } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { Context } from "@axi/chord";
import { FileError, type FileWatcher, type WatchChange, type WatchTarget } from "./index.ts";
import { fileError } from "./node-files.ts";

export interface NodeWatchOptions {
	mode?: "native" | "polling";
	pollIntervalMs?: number;
	maxDirectories?: number;
}

interface Target extends WatchTarget {
	path: string;
}
interface Observed {
	identity: string;
	value: string;
	directory: boolean;
}
interface Inventory {
	entries: Map<string, Observed>;
	coverage: Map<string, string>;
}

function inside(path: string, parent: string): boolean {
	return path === parent || path.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}
function parents(path: string): string[] {
	const paths: string[] = [];
	for (let parent = dirname(path); ; parent = dirname(parent)) {
		paths.push(parent);
		if (dirname(parent) === parent) return paths;
	}
}
function hidden(target: Target, name: string): boolean {
	return (target.exclude?.hidden === true && name.startsWith(".")) || target.exclude?.names?.includes(name) === true;
}
function relevant(target: Target, path: string): boolean {
	if (!inside(path, target.path)) return false;
	const subpath = relative(target.path, path);
	const parts = subpath ? subpath.split(sep) : [];
	return (target.recursive || parts.length <= 1) && !parts.some((name) => hidden(target, name));
}

async function preferredMode(targets: readonly Target[]): Promise<"polling" | "native"> {
	if (process.platform === "win32") return "polling";
	if (process.platform === "linux" || process.platform === "android") {
		const remote = new Set([
			0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x65735546, 0x01021997, 0x0bd00bd0, 0x47504653, 0x00c36400, 0x5346414f,
			0x6b414653, 0x5dca2df5,
		]);
		for (const target of targets)
			for (const path of [target.path, ...parents(target.path)]) {
				try {
					if (remote.has((await statfs(path)).type)) return "polling";
					break;
				} catch {}
			}
	}
	return "native";
}

export class NodeFileWatcher implements FileWatcher {
	readonly #targets: readonly Target[];
	readonly #callback: (change: WatchChange) => void;
	readonly #options: NodeWatchOptions;
	readonly #handles = new Map<string, { identity: string; handle: FSWatcher }>();
	readonly #eventPaths = new Set<string>();
	#mode: "native" | "polling";
	#entries = new Map<string, Observed>();
	#closed = false;
	#dirty = false;
	#running: Promise<void> | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#settleTimer: ReturnType<typeof setTimeout> | undefined;
	private constructor(
		targets: readonly Target[],
		callback: (change: WatchChange) => void,
		options: NodeWatchOptions,
		mode: "native" | "polling",
	) {
		this.#targets = targets;
		this.#callback = callback;
		this.#options = {
			pollIntervalMs: options.pollIntervalMs ?? 2000,
			maxDirectories: options.maxDirectories ?? 10000,
		};
		this.#mode = mode;
	}
	get mode(): "native" | "polling" {
		return this.#mode;
	}
	static async open(
		targets: readonly WatchTarget[],
		resolve: (path: string) => string,
		callback: (change: WatchChange) => void,
		options: NodeWatchOptions,
	): Promise<NodeFileWatcher> {
		const resolved = targets.map((target) => ({
			path: resolve(target.path),
			recursive: target.recursive === true,
			exclude: { hidden: target.exclude?.hidden === true, names: [...(target.exclude?.names ?? [])] },
		}));
		const watcher = new NodeFileWatcher(resolved, callback, options, options.mode ?? (await preferredMode(resolved)));
		try {
			await watcher.#synchronize(false);
		} catch (error) {
			watcher.#stop();
			throw error;
		}
		watcher.#poll();
		return watcher;
	}
	#emit(change: WatchChange): void {
		if (this.#closed) return;
		try {
			this.#callback(change);
		} catch {}
	}
	#stop(): void {
		this.#closed = true;
		clearTimeout(this.#timer);
		clearTimeout(this.#settleTimer);
		for (const { handle } of this.#handles.values()) handle.close();
		this.#handles.clear();
	}
	async close(_context: Context): Promise<void> {
		this.#stop();
		await this.#running;
	}
	#poll(): void {
		if (this.#closed || this.#mode !== "polling") return;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => this.#request(), this.#options.pollIntervalMs ?? 2000);
	}
	#request(): void {
		if (this.#closed) return;
		this.#dirty = true;
		if (this.#running !== undefined) return;
		this.#running = (async () => {
			try {
				while (this.#dirty && !this.#closed) {
					this.#dirty = false;
					await this.#synchronize(true);
				}
			} catch (error) {
				this.#emit({
					error:
						error instanceof FileError
							? error
							: new FileError(
									error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")
										? "permission_denied"
										: "invalid",
									error instanceof Error ? error.message : String(error),
								),
				});
				this.#stop();
			} finally {
				this.#running = undefined;
				this.#poll();
			}
		})();
	}
	#reported(path: string): string {
		if (this.#targets.some((target) => inside(path, target.path))) return path;
		return this.#targets.find((target) => inside(target.path, path))?.path ?? path;
	}
	#event(path: string, unknownName = false): void {
		if (this.#closed) return;
		const inScope = this.#targets.some((target) => inside(target.path, path) || relevant(target, path));
		if (inScope) this.#eventPaths.add(this.#reported(path));
		if (!inScope && !unknownName) return;
		if (this.#timer === undefined)
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				this.#request();
			}, 50);
	}
	async #inventory(): Promise<Inventory> {
		const entries = new Map<string, Observed>();
		const coverage = new Map<string, string>();
		const directories = new Set<string>();
		const roots = new Set<string>();
		const observe = async (path: string, follow: boolean, ancestorFor?: string): Promise<Observed | undefined> => {
			try {
				const stats = await (follow ? stat(path) : lstat(path));
				const directory = stats.isDirectory();
				const kind = directory ? "directory" : stats.isFile() ? "file" : stats.isSymbolicLink() ? "symlink" : "other";
				const identity = `${stats.dev}:${stats.ino}`;
				let hash = "";
				if (
					ancestorFor === undefined &&
					this.#mode === "polling" &&
					stats.isFile() &&
					stats.size <= 256 * 1024 &&
					Date.now() - stats.mtimeMs < 5000
				) {
					try {
						hash = createHash("sha256")
							.update(await readFile(path))
							.digest("hex");
					} catch {}
				}
				const previous = entries.get(path);
				const entry: Observed = {
					identity,
					value:
						directory || ancestorFor !== undefined
							? `${identity}:${stats.isSymbolicLink() ? "symlink" : directory ? "directory" : "ancestor"}`
							: `${identity}:${kind}:${stats.size}:${stats.mtimeMs}:${hash}`,
					directory,
				};
				if (follow || previous === undefined || (!roots.has(path) && ancestorFor === undefined))
					entries.set(path, entry);
				if (directory && (follow || ancestorFor !== undefined)) coverage.set(path, identity);
				return entry;
			} catch (error) {
				if (fileError(error, path).code === "not_found") return undefined;
				throw error;
			}
		};
		for (const target of this.#targets) {
			for (const path of parents(target.path)) await observe(path, false, target.path).catch(() => undefined);
			const root = await observe(target.path, true).catch((error) => {
				if (fileError(error, target.path).code === "permission_denied") throw error;
				return undefined;
			});
			roots.add(target.path);
			if (!root) continue;
			if (!root.directory) {
				if ((await lstat(target.path).catch(() => undefined))?.isSymbolicLink())
					coverage.set(target.path, root.identity);
				continue;
			}
			const walk = async (path: string, first: boolean): Promise<void> => {
				const entry = entries.get(path);
				if (entry) coverage.set(path, entry.identity);
				directories.add(path);
				if (directories.size > (this.#options.maxDirectories ?? 10000))
					throw new FileError("invalid", `Watched paths exceed ${this.#options.maxDirectories} directories`);
				let names: string[];
				try {
					names = await readdir(path);
				} catch (error) {
					const code = fileError(error, path).code;
					if (code === "not_found" || code === "not_directory" || (!first && code === "permission_denied")) return;
					throw error;
				}
				for (const name of names) {
					if (hidden(target, name)) continue;
					const child = join(path, name);
					const entry = await observe(child, false).catch(() => undefined);
					if (entry?.directory && target.recursive) await walk(child, false);
				}
			};
			await walk(target.path, true);
		}
		return { entries, coverage };
	}
	#install({ coverage, entries }: Inventory): boolean {
		if (this.#closed || this.#mode !== "native") return false;
		const perDirectory = process.platform === "linux" || process.platform === "android";
		const wanted = new Map<string, boolean>();
		for (const path of coverage.keys()) if (!entries.get(path)?.directory) wanted.set(path, false);
		for (const target of this.#targets) {
			for (const path of parents(target.path))
				if (entries.get(path)?.directory && !wanted.has(path)) wanted.set(path, false);
			if (!entries.get(target.path)?.directory) continue;
			wanted.set(target.path, target.recursive === true && !perDirectory);
			if (target.recursive && perDirectory)
				for (const [path, entry] of entries)
					if (entry.directory && path !== target.path && inside(path, target.path)) wanted.set(path, false);
		}
		for (const [path, installed] of this.#handles)
			if (!wanted.has(path) || entries.get(path)?.identity !== installed.identity) {
				installed.handle.close();
				this.#handles.delete(path);
			}
		let added = false;
		for (const [path, recursive] of wanted) {
			if (this.#handles.has(path)) continue;
			const entry = entries.get(path);
			if (entry === undefined) continue;
			try {
				const handle = watch(path, { recursive, persistent: false }, (_event, name) =>
					this.#event(!entries.get(path)?.directory || name === null ? path : join(path, String(name)), name === null),
				);
				handle.on("error", () => {
					handle.close();
					if (this.#handles.get(path)?.handle === handle) this.#handles.delete(path);
					this.#request();
				});
				this.#handles.set(path, { identity: entry.identity, handle });
				added = true;
			} catch (error) {
				if (this.#fallback(error)) return false;
			}
		}
		if (added && process.platform === "darwin") {
			clearTimeout(this.#settleTimer);
			this.#settleTimer = setTimeout(() => this.#request(), 500);
		}
		return added;
	}
	#fallback(error: unknown): boolean {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code === "ENOENT" ||
			error.code === "EACCES" ||
			error.code === "EPERM"
		)
			return false;
		if (this.#mode === "polling") return false;
		this.#mode = "polling";
		for (const { handle } of this.#handles.values()) handle.close();
		this.#handles.clear();
		this.#emit({ overflow: true });
		return true;
	}
	async #synchronize(publish: boolean): Promise<void> {
		const deliver = publish;
		const changed = new Set(this.#eventPaths);
		this.#eventPaths.clear();
		for (let round = 0; round < 10 && !this.#closed; round++) {
			const next = await this.#inventory();
			if (this.#closed) return;
			if (publish)
				for (const path of new Set([...this.#entries.keys(), ...next.entries.keys()])) {
					const before = this.#entries.get(path),
						after = next.entries.get(path);
					if (before?.value === after?.value) continue;
					changed.add(this.#reported(path));
				}
			this.#entries = next.entries;
			if (!this.#install(next)) break;
			publish = true;
		}
		if (deliver && changed.size) this.#emit({ paths: [...changed].sort() });
	}
}
