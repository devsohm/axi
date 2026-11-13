import { createSourceMapStore } from "@vitest/istanbul-lib-source-maps";
import istanbul from "@vitest/coverage-istanbul";
import { globSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createSourceInstrumenter, transformSource } from "./coverage-instrument.ts";

export function normalizeCoveragePaths(input, output) {
	for (const file of input.files()) {
		output.addFileCoverage({ ...input.fileCoverageFor(file).toJSON(), path: file.replaceAll("\\", "/") });
	}
	return output;
}

export const typescriptSources = {
	name: "coverage-source-typescript",
	enforce: "pre",
	transform(code, id) {
		if (!/\.[cm]?ts(?:\?|$)/.test(id)) return;
		return transformSource(code, id);
	},
};

export default {
	...istanbul,
	// Vitest exports its own counters; exit snapshots belong to independently started runtimes.
	startCoverage(options) {
		globalThis.__AXI_COVERAGE_TEST_RUNNER__ = true;
		return istanbul.startCoverage(options);
	},
	async getProvider() {
		const provider = await istanbul.getProvider();
		provider.name = "custom";
		const initialize = provider.initialize.bind(provider);
		let root, directory;
		provider.initialize = (ctx) => {
			initialize(ctx);
			root = ctx.config.root;
			directory = join(provider.coverageFilesDirectory, "node");
			process.env.AXI_COVERAGE_ROOT = root;
			process.env.AXI_COVERAGE_DIRECTORY = directory;
			process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${new URL("./coverage-node.mjs", import.meta.url).href}`;
		};
		const clean = provider.clean.bind(provider);
		provider.clean = async (...args) => {
			await clean(...args);
			mkdirSync(directory, { recursive: true });
		};
		const generate = provider.generateCoverage.bind(provider);
		provider.generateCoverage = async (options) => {
			const map = normalizeCoveragePaths(await generate(options), provider.createCoverageMap());
			for (const name of readdirSync(directory)) {
				const raw = provider.createCoverageMap();
				raw.merge(JSON.parse(readFileSync(join(directory, name), "utf8")));
				const report = normalizeCoveragePaths(await createSourceMapStore().transformCoverage(raw), provider.createCoverageMap()).toJSON();
				for (const file of Object.keys(report)) {
					if (!provider.isIncluded(file)) throw new Error(`Unexpected child coverage: ${file}`);
					if (map.files().includes(file)) {
						const previous = map.fileCoverageFor(file).toJSON(),
							next = report[file];
						const shape = (f) => [
							Object.values(f.statementMap),
							Object.values(f.fnMap).map(({ name, decl, loc }) => ({ name, decl, loc })),
							Object.values(f.branchMap).map(({ type, loc, locations }) => ({ type, loc, locations })),
						];
						if (JSON.stringify(shape(previous)) !== JSON.stringify(shape(next)))
							throw new Error(`Child coverage maps differ: ${file}`);
					}
				}
				map.merge(report);
			}
			if (options.allTestsRun) {
				const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
				const instrumenter = createSourceInstrumenter();
				for (const file of globSync(
					manifest.workspaces ? manifest.workspaces.map((w) => `${w}/src/**/*.ts`) : "src/**/*.ts",
					{ cwd: root },
				)) {
					if (file.endsWith(".d.ts")) continue;
					const absolute = join(root, file).replaceAll("\\", "/");
					if (map.files().includes(absolute)) continue;
					instrumenter.instrumentSync(
						transformSource(readFileSync(absolute, "utf8"), absolute).code,
						absolute,
					);
					const empty = instrumenter.lastFileCoverage();
					if (
						Object.keys(empty.statementMap).length ||
						Object.keys(empty.fnMap).length ||
						Object.keys(empty.branchMap).length
					)
						throw new Error(`Executable module is absent from coverage: ${file}`);
					// Type-only sources belong to the inventory even when they have no executable counters.
					map.addFileCoverage(empty);
				}
			}
			return map;
		};
		return provider;
	},
};
