import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
import { relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { threadId } from "node:worker_threads";
import { onExit } from "signal-exit";
import { createSourceInstrumenter, transformSource } from "./coverage-instrument.ts";

const root = process.env.AXI_COVERAGE_ROOT,
	directory = process.env.AXI_COVERAGE_DIRECTORY;
if (root && directory && process.env.AXI_COVERAGE_ATTACH !== "0") {
	const files = new Map();
	globalThis.__AXI_COVERAGE_SOURCE_MAPS__ = files;
	const instrumenter = createSourceInstrumenter();
	registerHooks({
		load(url, context, next) {
			const result = next(url, context);
			if (!url.startsWith("file:")) return result;
			const file = fileURLToPath(url).replaceAll("\\", "/"),
				path = relative(root, file).replaceAll("\\", "/");
			if (!/^(?:packages\/[^/]+\/)?src\/.*\.ts$/.test(path) || path.endsWith(".d.ts")) return result;
			const source = typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8");
			const transformed = transformSource(source, file);
			files.set(file, transformed.map);
			return {
				...result,
				format: "module",
				source: instrumenter.instrumentSync(transformed.code, file),
			};
		},
	});
	onExit(
		() => {
			if (globalThis.__AXI_COVERAGE_TEST_RUNNER__) return;
			const report = Object.fromEntries(
				[...files]
					.filter(([file]) => globalThis.__VITEST_COVERAGE__?.[file])
					.map(([file, inputSourceMap]) => [file, { ...globalThis.__VITEST_COVERAGE__[file], inputSourceMap }]),
			);
			if (Object.keys(report).length)
				writeFileSync(join(directory, `${process.pid}-${threadId}.json`), JSON.stringify(report));
		},
		{ alwaysLast: true },
	);
}
