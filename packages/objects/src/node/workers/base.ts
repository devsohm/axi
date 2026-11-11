import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, parse, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Loader, type Plugin } from "esbuild";
import { readRecorded, recordedSources, type BaseInputs } from "../plugins/base-inputs.ts";
import { conditionsOf } from "../surfaces/bundle.ts";

export interface WorkerBase {
	readonly inputs: BaseInputs;
	file(): string;
	remove(): void;
}

export async function buildWorkerBase(entry: string, execArgv: readonly string[], dir?: string): Promise<WorkerBase> {
	const inputs = new Map<string, string>();
	const root = parse(resolve(entry)).root;
	const result = await build({
		entryPoints: { worker: entry },
		outdir: root,
		outExtension: { ".js": ".mjs" },
		entryNames: "[name]",
		chunkNames: "[name]-[hash]",
		splitting: true,
		write: false,
		bundle: true,
		format: "esm",
		platform: "node",
		mainFields: ["main"],
		conditions: conditionsOf(execArgv),
		ignoreAnnotations: true,
		keepNames: true,
		sourcemap: "linked",
		sourcesContent: false,
		sourceRoot: pathToFileURL(root).href,
		logLevel: "silent",
		banner: {
			js: 'import { createRequire as __axiRequire } from "node:module"; const require = __axiRequire(import.meta.url);',
		},
		define: {
			"import.meta.url": "__axiSourceURL",
			"import.meta.dirname": "__axiSourceDir",
			"import.meta.filename": "__axiSourceFile",
			__dirname: "__axiSourceDir",
			__filename: "__axiSourceFile",
		},
		plugins: [workerSources(inputs), recordedSources(inputs)],
	});
	return new Snapshot(
		result.outputFiles.map(output => ({ name: basename(output.path), bytes: output.contents })),
		inputs,
		dir,
	);
}

export async function nodeBaseInputs(entry: string, conditions: readonly string[]): Promise<BaseInputs> {
	const inputs = new Map<string, string>(), resolving = Symbol("static-import");
	await build({
		entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "node",
		mainFields: ["main"], conditions: [...conditions], tsconfigRaw: "{}", ignoreAnnotations: true, logLevel: "silent",
		plugins: [{ name: "axi-static-inputs", setup(build) {
			build.onResolve({ filter: /.*/ }, async args => {
				if (args.kind === "entry-point" || args.pluginData === resolving || isBuiltin(args.path)) return;
				const found = await build.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: resolving });
				return found.errors.length || found.external || found.path.split(sep).includes("node_modules")
					? { path: args.path, external: true } : found;
			});
		} }, recordedSources(inputs)],
	});
	return inputs;
}

function workerSources(inputs: Map<string, string>): Plugin {
	const resolving = Symbol("resolve-package");
	const loaders: Record<string, Loader> = {
		".js": "js",
		".mjs": "js",
		".cjs": "js",
		".jsx": "jsx",
		".ts": "ts",
		".mts": "ts",
		".cts": "ts",
		".tsx": "tsx",
	};
	return {
		name: "axi-worker-sources",
		setup(builder) {
			builder.onResolve({ filter: /^[^./]/ }, async (args) => {
				if (args.pluginData === resolving || isBuiltin(args.path)) return;
				const found = await builder.resolve(args.path, {
					kind: args.kind,
					importer: args.importer,
					resolveDir: args.resolveDir,
					pluginData: resolving,
				});
				if (found.errors.length) return;
				return found.path.split(sep).includes("node_modules")
					? { path: args.kind.startsWith("require") ? found.path : pathToFileURL(found.path).href, external: true }
					: found;
			});
			builder.onLoad({ filter: /\.(?:[cm]?[jt]s|[jt]sx)$/ }, async ({ path, namespace }) => {
				if (namespace !== "file") return;
				const bytes = await readRecorded(path, inputs), source = bytes.toString("utf8");
				if (!/import\.meta|__dirname|__filename/.test(source)) return { contents: bytes, loader: loaders[extname(path)]! };
				const declarations = `var __axiSourceURL=${JSON.stringify(pathToFileURL(path).href)},__axiSourceDir=${JSON.stringify(dirname(path))},__axiSourceFile=${JSON.stringify(path)};`;
				return { contents: declarations + source, loader: loaders[extname(path)]! };
			});
		},
	};
}

class Snapshot implements WorkerBase {
	readonly inputs: BaseInputs;
	readonly #outputs: readonly { readonly name: string; readonly bytes: Uint8Array }[];
	readonly #named: string | undefined;
	#directory: string | undefined;
	constructor(
		outputs: readonly { readonly name: string; readonly bytes: Uint8Array }[],
		inputs: BaseInputs,
		named?: string,
	) {
		this.#outputs = outputs;
		this.inputs = inputs;
		this.#named = named;
	}
	file(): string {
		const written = this.#directory;
		if (written === undefined || this.#outputs.some((output) => !existsSync(join(written, output.name)))) {
			this.remove();
			const destination = this.#named ?? mkdtempSync(join(tmpdir(), "axi-worker-"));
			if (this.#named !== undefined) {
				rmSync(destination, { recursive: true, force: true });
				mkdirSync(destination, { recursive: true, mode: 0o700 });
			}
			for (const output of this.#outputs) writeFileSync(join(destination, output.name), output.bytes, { mode: 0o600 });
			this.#directory = destination;
			return join(destination, "worker.mjs");
		}
		return join(written, "worker.mjs");
	}
	remove(): void {
		if (this.#directory !== undefined) rmSync(this.#directory, { recursive: true, force: true });
		this.#directory = undefined;
	}
}
