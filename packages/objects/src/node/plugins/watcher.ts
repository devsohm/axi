import { type Dirent, type FSWatcher, existsSync, lstatSync, readdirSync, realpathSync, watch } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import { type Batch, Source } from "../../state/internal.ts";
import { type BuiltFacet, inside } from "./build.ts";
import { type Discovery, FACET_EXTENSIONS, sameFiles } from "./discover.ts";

export type PluginsState = {
	readonly dirty: readonly string[];
	readonly install: readonly string[];
	readonly set: boolean;
	readonly base: boolean;
};
export type MarkSnapshot = { readonly plugins: ReadonlyMap<string, number> };
export type DiscoverySnapshot = { readonly set: number; readonly manifest: number };
export type WatcherOptions = {
	readonly roots: readonly string[];
	readonly base: readonly string[];
	readonly kinds: readonly string[];
	readonly failed: (error: unknown) => void;
};
const ignored = (name: string): boolean => name === "node_modules" || name === ".git";
function realDirectory(dir: string): string {
	try {
		return realpathSync(dir);
	} catch {
		return resolve(dir);
	}
}
export class PluginWatcher extends Source {
	readonly #options: WatcherOptions;
	readonly #roots: readonly string[];
	readonly #base: readonly string[];
	readonly #trees = new Set<string>();
	readonly #directories = new Map<string, FSWatcher>();
	readonly #marks = new Map<string, number>();
	readonly #install = new Set<string>();
	readonly #inputs = new Map<string, { readonly plugin: string; readonly files: ReadonlySet<string> }>();
	#known: Discovery = { plugins: [], problems: [] };
	#clock = 1;
	#set = 0;
	#manifest = 0;
	#baseChanged = false;
	#unavailable = false;
	#scheduled = false;
	#cached: JsonValue | undefined;
	constructor(options: WatcherOptions, batch: Batch) {
		super(batch);
		this.#options = options;
		this.#roots = options.roots.map(realDirectory);
		this.#base = options.base.map(realDirectory);
		for (const directory of [...this.#roots, ...this.#base]) this.#tree(directory);
	}
	get value(): JsonValue {
		return (this.#cached ??= {
			dirty: [...this.#marks.keys()].sort(),
			install: [...this.#install].sort(),
			set: this.#set > 0,
			base: this.#baseChanged,
		});
	}
	deliver(context: Context): void {
		const value = this.value;
		this.publish(value, [["r", value]], false, context);
	}
	get needsDiscovery(): boolean {
		return this.#set > 0 || this.#manifest > 0;
	}
	discoverySnapshot(): DiscoverySnapshot {
		return { set: this.#set, manifest: this.#manifest };
	}
	know(discovery: Discovery, seen: DiscoverySnapshot): void {
		const stamp = this.#clock++;
		for (const plugin of discovery.plugins) {
			const previous = this.#known.plugins.find(({ name }) => name === plugin.name);
			if (previous && !sameFiles(previous, plugin)) this.#marks.set(plugin.name, stamp);
		}
		const names = new Set(discovery.plugins.map(({ name }) => name));
		for (const [key, input] of this.#inputs) if (!names.has(input.plugin)) this.#inputs.delete(key);
		this.#known = discovery;
		if (seen.set === this.#set) this.#set = 0;
		if (seen.manifest === this.#manifest) this.#manifest = 0;
		const present = new Set(discovery.plugins.map(({ name }) => name));
		for (const name of this.#install) if (!present.has(name)) this.#install.delete(name);
		const linked = discovery.plugins
			.filter(({ dir }) => !this.#roots.some((root) => inside(root, dir)))
			.map(({ dir }) => dir);
		for (const dir of linked) this.#tree(dir);
		for (const dir of this.#trees) {
			if (this.#roots.includes(dir) || this.#base.includes(dir) || linked.includes(dir)) continue;
			this.#trees.delete(dir);
			this.#removeWatches(dir);
		}
		this.#notify();
	}
	used(facets: readonly BuiltFacet[]): void {
		for (const facet of facets)
			if (facet.kind === "script")
				this.#inputs.set(`${facet.plugin}\0${facet.facet}`, {
					plugin: facet.plugin,
					files: new Set([...facet.inputs.map(({ file }) => file), ...facet.copied]),
				});
	}
	snapshot(names: Iterable<string>): MarkSnapshot {
		return { plugins: new Map([...names].map((name) => [name, this.#marks.get(name) ?? 0])) };
	}
	applied(names: Iterable<string>, snapshot: MarkSnapshot): void {
		for (const name of names) {
			const stamp = this.#marks.get(name);
			if (stamp !== undefined && stamp <= (snapshot.plugins.get(name) ?? 0)) this.#marks.delete(name);
		}
		this.#notify();
	}
	installed(name: string): void {
		this.#install.delete(name);
		this.#marks.set(name, this.#clock++);
		this.#notify();
	}
	added(): void { this.#set = this.#clock++; this.#notify(); }
	mark(path: string): void {
		if (path.split(sep).some(ignored)) return;
		if (this.#base.some((dir) => inside(dir, path))) this.#baseChanged = true;
		else {
			const stamp = this.#clock++;
			const owner = this.#known.plugins.find((plugin) => plugin.layout === "file" ? Object.values(plugin.facets).includes(path) : plugin.dir === path || inside(plugin.dir, path));
			if (!owner) {
				if (this.#roots.some((dir) => inside(dir, path))) this.#set = stamp;
			} else if (path === join(owner.dir, "package.json")) {
				this.#install.add(owner.name);
				this.#manifest = stamp;
			} else {
				if (
					(owner.layout === "file" && !existsSync(path)) || path === owner.dir ||
					(dirname(path) === owner.dir &&
						this.#options.kinds.some((kind) =>
							FACET_EXTENSIONS.some((extension) => basename(path) === kind + extension),
						))
				)
					this.#set = stamp;
				this.#marks.set(owner.name, stamp);
			}
			for (const { plugin, files } of this.#inputs.values()) if (files.has(path)) this.#marks.set(plugin, stamp);
		}
		this.#notify();
	}
	close(): void {
		for (const watcher of this.#directories.values()) watcher.close();
		this.#directories.clear();
		this.#trees.clear();
	}
	#tree(dir: string): void {
		if (this.#trees.has(dir)) return;
		this.#trees.add(dir);
		this.#scan(dir);
	}
	#scan(dir: string): void {
		if (this.#directories.has(dir) || this.#unavailable) return;
		let handle: FSWatcher;
		try {
			handle = watch(dir, (_kind, file) => {
				if (file !== null) this.#event(join(dir, file));
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#failure(error);
			return;
		}
		handle.on("error", (error) => this.#failure(error));
		this.#directories.set(dir, handle);
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) if (entry.isDirectory() && !ignored(entry.name)) this.#scan(join(dir, entry.name));
	}
	#event(path: string): void {
		if (!ignored(basename(path))) {
			let directory = false;
			try {
				directory = lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
			} catch {}
			if (directory) this.#scan(path);
			else if (this.#directories.has(path)) this.#removeWatches(path);
		}
		this.mark(path);
	}
	#removeWatches(dir: string): void {
		for (const [path, handle] of this.#directories)
			if (path === dir || inside(dir, path)) {
				handle.close();
				this.#directories.delete(path);
			}
	}
	#failure(error: unknown): void {
		this.close();
		if (this.#unavailable) return;
		this.#unavailable = true;
		this.#options.failed(error);
	}
	#notify(): void {
		this.#cached = undefined;
		if (this.#scheduled || (!this.watched && this.dependents.size === 0)) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			this.batch.within(() => this.changed(), BACKGROUND_CONTEXT);
		});
	}
}
