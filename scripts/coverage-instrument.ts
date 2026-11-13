import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInstrumenter } from "@vitest/istanbul-lib-instrument";
import type { Plugin } from "esbuild";
import MagicString from "magic-string";

export const createSourceInstrumenter = () =>
	createInstrumenter({
		produceSourceMap: true,
		autoWrap: false,
		esModules: true,
		compact: false,
		coverageVariable: "__VITEST_COVERAGE__",
		coverageGlobalScope: "globalThis",
		coverageGlobalScopeFunc: false,
		ignoreLines: true,
		combineSourceMaps: false,
		inputSourceMap: false,
	});

export function transformSource(code: string, file: string) {
	return {
		code: stripTypeScriptTypes(code, { mode: "strip" }),
		map: new MagicString(code).generateMap({ source: file, includeContent: true, hires: true }),
	};
}

export function workspaceSource(specifier: string): string | undefined {
	if (!specifier.startsWith("@axi/")) return;
	const target = fileURLToPath(import.meta.resolve(specifier)).replaceAll("\\", "/");
	const source = target.replace(/\/dist\/(.*)\.js$/, "/src/$1.ts");
	if (source !== target && existsSync(source)) return source;
}

export function bundleCoverage(directory: string | undefined) {
	const maps = new Map<string, ReturnType<typeof transformSource>["map"]>();
	const plugin: Plugin = {
		name: "source-coverage",
		setup(builder) {
			if (!directory) return;
			builder.onResolve({ filter: /^@axi\// }, ({ path }) => {
				const source = workspaceSource(path);
				if (source) return { path: source };
			});
			const instrumenter = createSourceInstrumenter();
			builder.onLoad({ filter: /[/\\]packages[/\\][^/\\]+[/\\]src[/\\].*\.ts$/ }, ({ path }) => {
				const source = transformSource(readFileSync(path, "utf8"), path);
				maps.set(path, source.map);
				return {
					contents: instrumenter.instrumentSync(source.code, path),
					loader: "js",
					resolveDir: dirname(path),
				};
			});
		},
	};
	return {
		plugin,
		write(report: Record<string, object>) {
			if (!directory) throw new Error("Bundle coverage is disabled");
			const result = Object.fromEntries(
				Object.entries(report).map(([file, coverage]) => {
					const inputSourceMap = maps.get(file);
					if (!inputSourceMap) throw new Error(`Unexpected bundle coverage: ${file}`);
					return [file, { ...coverage, inputSourceMap }];
				}),
			);
			writeFileSync(join(directory, `bundle-${randomUUID()}.json`), JSON.stringify(result));
		},
	};
}
