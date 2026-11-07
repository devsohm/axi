import { lstatSync, readdirSync, readFileSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { contentHash, type BaseInputs } from "./base-inputs.ts";
import { inside } from "./build.ts";

const extensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css"]);
const ignored = (path: string) => path.split(sep).some((part) => part === "node_modules" || part === ".git");
function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}
function directory(path: string): boolean {
	try {
		return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
	} catch {
		return false;
	}
}
export function directoryIdentity(path: string): string | undefined {
	try {
		const stat = lstatSync(path, { bigint: true });
		return `${stat.ino}:${stat.birthtimeNs}`;
	} catch {
		return undefined;
	}
}
function sources(path: string): string[] {
	if (!directory(path)) return extensions.has(extname(path)) ? [path] : [];
	try {
		return readdirSync(path).flatMap((name) => (ignored(name) ? [] : sources(join(path, name))));
	} catch {
		return [];
	}
}

export class BaseWatcher {
	readonly #roots: readonly string[];
	readonly #expected = new Map<string, Set<string>>();
	readonly #different = new Set<string>();
	readonly #reads = new Map<string, Promise<void>>();
	readonly #locations = new Set<string>();
	readonly #ancestors = new Set<string>();
	readonly #watches = new Map<string, { handle: FSWatcher; identity: string | undefined }>();
	readonly #renew = new Set<string>();
	readonly #changed: () => void;
	readonly #failed: (error: unknown) => void;
	#scheduled = false;
	#closed = false;
	#unavailable = false;

	constructor(paths: readonly string[], changed: () => void, failed: (error: unknown) => void) {
		this.#changed = changed;
		this.#failed = failed;
		const base = paths.map(real);
		this.#roots = base.filter(directory);
		for (const root of this.#roots) this.#locate(root);
		for (const file of base.flatMap((path) => (this.#roots.includes(path) ? sources(path) : [path]))) {
			this.#locate(dirname(file));
			try {
				this.#expect(file, contentHash(readFileSync(file)));
			} catch {}
		}
	}

	get changed(): boolean {
		return this.#different.size !== 0;
	}
	#inRoot(path: string): boolean {
		return this.#roots.some((root) => root === path || inside(root, path));
	}
	includes(path: string): boolean {
		return (
			this.#inRoot(path) ||
			this.#different.has(path) ||
			this.#expected.has(path) ||
			[...this.#expected.keys()].some((file) => inside(path, file))
		);
	}
	#expect(path: string, hash: string): void {
		let hashes = this.#expected.get(path);
		if (!hashes) this.#expected.set(path, (hashes = new Set()));
		hashes.add(hash);
	}
	record(inputs: BaseInputs): void {
		for (const [file, hash] of inputs) {
			const path = real(file);
			if (ignored(path)) continue;
			this.#expect(path, hash);
			this.#locate(dirname(path));
			this.#compare(path);
		}
	}
	mark(path: string): void {
		const files = new Set<string>();
		if (this.#expected.has(path) || this.#different.has(path)) files.add(path);
		else {
			for (const file of [...this.#expected.keys(), ...this.#different]) if (inside(path, file)) files.add(file);
			for (const root of this.#roots) {
				const scan = path === root || inside(path, root) ? root : inside(root, path) ? path : undefined;
				if (scan !== undefined) for (const file of sources(scan)) files.add(file);
			}
		}
		for (const file of files) this.#compare(file);
	}
	#compare(path: string): void {
		const pending = (this.#reads.get(path) ?? Promise.resolve()).then(async () => {
			let hash: string | undefined;
			try {
				hash = contentHash(await readFile(path));
			} catch {}
			const hashes = this.#expected.get(path);
			const differs = hashes
				? [...hashes].some((expected) => expected !== hash)
				: hash !== undefined && this.#inRoot(path) && extensions.has(extname(path));
			if (differs === this.#different.has(path)) return;
			if (differs) this.#different.add(path);
			else this.#different.delete(path);
			this.#changed();
		});
		this.#reads.set(path, pending);
		void pending.then(() => {
			if (this.#reads.get(path) === pending) this.#reads.delete(path);
		});
	}
	#locate(path: string): void {
		if (this.#locations.has(path) || (this.#inRoot(path) && !this.#roots.includes(path))) return;
		this.#locations.add(path);
		for (let current = path; ; current = dirname(current)) {
			this.#ancestors.add(current);
			if (current === dirname(current)) break;
		}
		this.#attach(path);
	}
	#attach(path: string): void {
		const chain: string[] = [];
		for (let current = dirname(path); ; current = dirname(current)) {
			chain.unshift(current);
			if (current === dirname(current)) break;
		}
		for (const ancestor of chain) this.#watch(ancestor, false);
		this.#watch(path, this.#roots.includes(path));
	}
	#watch(path: string, tree: boolean): void {
		if (this.#unavailable || this.#watches.has(path)) return;
		let handle: FSWatcher;
		try {
			handle = watch(path, (event, name) => {
				if (name === null || ignored(name)) return;
				const file = join(path, name);
				if (tree) {
					if (this.#watches.has(file) && directoryIdentity(file) !== this.#watches.get(file)?.identity) this.#drop(file);
					if (directory(file)) this.#watch(file, true);
					this.mark(file);
				} else if (this.#expected.has(file) || this.#different.has(file)) this.mark(file);
				else if (
					event === "rename" &&
					this.#ancestors.has(file) &&
					directoryIdentity(file) !== this.#watches.get(file)?.identity
				)
					this.#renewAt(file);
			});
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && (tree || (code !== "EACCES" && code !== "EPERM"))) this.#fail(error);
			return;
		}
		handle.on("error", (error) => this.#fail(error));
		this.#watches.set(path, { handle, identity: directoryIdentity(path) });
		if (tree) {
			try {
				for (const entry of readdirSync(path, { withFileTypes: true }))
					if (entry.isDirectory() && !ignored(entry.name)) this.#watch(join(path, entry.name), true);
			} catch {}
		}
	}
	#renewAt(path: string): void {
		this.#renew.add(path);
		if (this.#scheduled) return;
		this.#scheduled = true;
		setImmediate(() => {
			this.#scheduled = false;
			const paths = [...this.#renew];
			this.#renew.clear();
			if (this.#closed || this.#unavailable) return;
			for (const path of paths) {
				if (paths.some((other) => inside(other, path))) continue;
				this.#drop(path);
				for (const location of this.#locations) if (path === location || inside(path, location)) this.#attach(location);
				this.mark(path);
			}
		});
	}
	#drop(path: string): void {
		for (const [dir, watch] of this.#watches)
			if (dir === path || inside(path, dir)) {
				watch.handle.close();
				this.#watches.delete(dir);
			}
	}
	#fail(error: unknown): void {
		this.close();
		if (this.#unavailable) return;
		this.#unavailable = true;
		this.#failed(error);
	}
	close(): void {
		this.#closed = true;
		for (const { handle } of this.#watches.values()) handle.close();
		this.#watches.clear();
	}
}
