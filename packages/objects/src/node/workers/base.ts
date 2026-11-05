import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, parse, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Loader, type Plugin } from "esbuild";
import { metafileInputs } from "../surfaces/bundle.ts";

export interface WorkerBase {
	readonly inputs: readonly string[];
	file(): string;
	remove(): void;
}

export async function buildWorkerBase(entry: string, execArgv: readonly string[]): Promise<WorkerBase> {
	const conditions: string[] = [];
	for (let index = 0; index < execArgv.length; index++) {
		const flag = execArgv[index]!;
		if (flag === "--conditions" || flag === "-C") {
			if (index + 1 < execArgv.length) conditions.push(execArgv[++index]!);
		} else if (flag.startsWith("--conditions=") || flag.startsWith("-C="))
			conditions.push(flag.slice(flag.indexOf("=") + 1));
	}
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
		conditions,
		ignoreAnnotations: true,
		keepNames: true,
		sourcemap: "inline",
		sourcesContent: false,
		sourceRoot: pathToFileURL(root).href,
		metafile: true,
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
		plugins: [workerSources()],
	});
	return new Snapshot(result.outputFiles.map(output => ({ name: basename(output.path), bytes: output.contents })), metafileInputs(result.metafile));
}

function workerSources(): Plugin {
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
			builder.onLoad({ filter: /\.(?:[cm]?[jt]s|[jt]sx)$/ }, async ({ path }) => {
				const source = await readFile(path, "utf8");
				if (!/import\.meta|__dirname|__filename/.test(source)) return;
				const declarations = `var __axiSourceURL=${JSON.stringify(pathToFileURL(path).href)},__axiSourceDir=${JSON.stringify(dirname(path))},__axiSourceFile=${JSON.stringify(path)};`;
				return { contents: declarations + source, loader: loaders[extname(path)]! };
			});
		},
	};
}

class Snapshot implements WorkerBase {
	readonly inputs: readonly string[];
	readonly #outputs: readonly { readonly name: string; readonly bytes: Uint8Array }[];
	#directory = "";
	#file = "";
	constructor(outputs: readonly { readonly name: string; readonly bytes: Uint8Array }[], inputs: readonly string[]) {
		this.#outputs = outputs;
		this.inputs = inputs;
		this.#save();
	}
	file(): string {
		if (this.#outputs.some(output => !existsSync(join(this.#directory, output.name)))) {
			this.remove();
			this.#save();
		}
		return this.#file;
	}
	remove(): void {
		rmSync(this.#directory, { recursive: true, force: true });
	}
	#save(): void {
		this.#directory = mkdtempSync(join(tmpdir(), "axi-worker-"));
		this.#file = join(this.#directory, "worker.mjs");
		for (const output of this.#outputs) writeFileSync(join(this.#directory, output.name), output.bytes, { mode: 0o600 });
	}
}
