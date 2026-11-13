import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import istanbul from "istanbul-lib-coverage";

const root = fileURLToPath(new URL("..", import.meta.url));
const { createCoverageMap } = istanbul;
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const write = (file, value) => writeFileSync(file, JSON.stringify(value) + "\n");
const targets = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64", "windows-arm64"];
const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function sources() {
	return Object.fromEntries(
		read(join(root, "package.json"))
			.workspaces.flatMap((workspace) =>
				globSync(`${workspace}/src/**/*.ts`, { cwd: root })
					.filter((file) => !file.endsWith(".d.ts"))
					.map((file) => [file.replaceAll("\\", "/"), hash(join(root, file))]),
			)
			.sort(([a], [b]) => a.localeCompare(b)),
	);
}
function safePath(file) {
	if (
		isAbsolute(file) ||
		file.includes("\\") ||
		!/^packages\/[^/]+\/src\/.+\.ts$/.test(file) ||
		file.split("/").includes("..")
	)
		throw new Error(`Invalid coverage source path: ${file}`);
	return file;
}
function counterShape(file) {
	return JSON.stringify(
		[file.statementMap, file.fnMap, file.branchMap].map((map) =>
			Object.values(map)
				.map((value) => JSON.stringify(value))
				.sort(),
		),
	);
}
function capture() {
	const directory = join(root, "coverage");
	const results = read(join(directory, "test-results.json"));
	if (!results.success || results.numFailedTests || results.numFailedTestSuites)
		throw new Error("Cannot capture a failed test run");
	const inventory = sources();
	const portable = {};
	for (const [file, data] of Object.entries(read(join(directory, "coverage-final.json")))) {
		const key = safePath(relative(root, file).replaceAll("\\", "/"));
		if (!Object.hasOwn(inventory, key)) throw new Error(`Coverage source is absent: ${key}`);
		portable[key] = { ...data, path: key };
	}
	if (Object.keys(portable).length !== Object.keys(inventory).length)
		throw new Error("Coverage is missing workspace source modules");
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	write(join(directory, "coverage-portable.json"), portable);
	write(join(directory, "coverage-platform.json"), {
		version: 1,
		target,
		node: process.version,
		commit: head,
		sources: inventory,
		instrumentation: {
			vitest: read(join(root, "node_modules/vitest/package.json")).version,
			provider: read(join(root, "node_modules/@vitest/coverage-istanbul/package.json")).version,
			instrumenterVersion: read(join(root, "node_modules/@vitest/istanbul-lib-instrument/package.json")).version,
			sourceMaps: read(join(root, "node_modules/@vitest/istanbul-lib-source-maps/package.json")).version,
			transformer: read(join(root, "node_modules/esbuild/package.json")).version,
			configuration: hash(join(root, "vitest.config.ts")),
			collector: hash(join(root, "scripts/coverage-provider.mjs")),
			processCollector: hash(join(root, "scripts/coverage-node.mjs")),
			instrumenter: hash(join(root, "scripts/coverage-instrument.ts")),
		},
		passed: results.numPassedTests,
		skipped: results.numPendingTests,
	});
	console.log(`Captured ${Object.keys(portable).length} coverage modules for ${target}`);
}
function merge(directory, output) {
	if (!directory) throw new Error("Expected the directory containing all six native coverage artifacts");
	const inventory = sources();
	const records = globSync("**/coverage-platform.json", { cwd: directory }).map((file) => {
		const metadata = read(join(directory, file));
		return { metadata, coverage: read(join(directory, file, "../coverage-portable.json")) };
	});
	if (
		records.length !== targets.length ||
		targets.some((target) => records.filter((record) => record.metadata.target === target).length !== 1)
	)
		throw new Error("Expected one successful coverage artifact for each native target");
	const expected = records[0].metadata;
	const shapes = new Map();
	const coverage = createCoverageMap({});
	for (const { metadata, coverage: files } of records) {
		if (
			metadata.version !== 1 ||
			metadata.commit !== expected.commit ||
			JSON.stringify(metadata.instrumentation) !== JSON.stringify(expected.instrumentation) ||
			JSON.stringify(metadata.sources) !== JSON.stringify(inventory)
		)
			throw new Error(`Coverage artifacts do not describe the same sources and instrumentation: ${metadata.target}`);
		if (
			!Number.isSafeInteger(metadata.passed) ||
			metadata.passed < 1 ||
			Object.keys(files).length !== Object.keys(inventory).length
		)
			throw new Error(`Coverage artifact lacks passing tests or workspace source modules: ${metadata.target}`);
		for (const [file, data] of Object.entries(files)) {
			safePath(file);
			if (!Object.hasOwn(inventory, file) || data.path !== file)
				throw new Error(`Coverage source is absent or mismatched: ${file}`);
			const shape = counterShape(data),
				previous = shapes.get(file);
			if (previous !== undefined && shape !== previous) throw new Error(`Coverage counter maps differ: ${file}`);
			shapes.set(file, shape);
			coverage.addFileCoverage({ ...data, path: join(root, file) });
		}
	}
	mkdirSync(output, { recursive: true });
	const summary = { total: coverage.getCoverageSummary().toJSON() };
	for (const file of coverage.files()) summary[file] = coverage.fileCoverageFor(file).toSummary().toJSON();
	write(join(output, "coverage-final.json"), coverage.toJSON());
	write(join(output, "coverage-summary.json"), summary);
	write(
		join(output, "platforms.json"),
		records.map(({ metadata: { sources, ...metadata } }) => metadata),
	);
	console.log(
		JSON.stringify(
			{ targets: records.map(({ metadata }) => metadata.target).sort(), coverage: summary.total },
			null,
			2,
		),
	);
}

const [command, directory, output] = process.argv.slice(2);
if (command === "capture") capture();
else if (command === "merge") merge(directory, resolve(output ?? join(root, "coverage/combined")));
else throw new Error("Expected capture or merge <artifact-directory> [output-directory]");
