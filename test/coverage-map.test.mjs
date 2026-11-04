import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { globSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const source = new URL("../scripts/test-coverage.mjs", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("the JavaScript runner selects every owned package and integration test", async () => {
	const config = (await import("../vitest.config.ts")).default;
	const root = fileURLToPath(new URL("..", import.meta.url));
	const files = [
		...globSync("packages/*/test/**/*.test.ts", { cwd: root }),
		...globSync("test/*.test.ts", { cwd: root }),
	];
	assert.ok(files.length > 0);
	for (const file of files)
		assert.ok(
			config.test.include.some((pattern) => matchesGlob(file, pattern)),
			`Unselected owned test: ${file}`,
		);
});

for (const scenario of ["complete", "missing workspace", "empty area", "foreign test", "unmeasured workspace"])
	test(`behavior report handles ${scenario}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "axi-coverage-map-"));
		const json = async (file, value) => {
			await mkdir(dirname(join(root, file)), { recursive: true });
			await writeFile(join(root, file), JSON.stringify(value));
		};
		try {
			await mkdir(join(root, "scripts"));
			await copyFile(source, join(root, "scripts/test-coverage.mjs"));
			await json("package.json", { workspaces: manifest.workspaces });
			const packages = [];
			const testResults = [];
			for (const directory of manifest.workspaces) {
				const { name } = JSON.parse(await readFile(new URL(`../${directory}/package.json`, import.meta.url), "utf8"));
				const file = `${directory}/test/check.test.ts`;
				await json(`${directory}/package.json`, { name });
				await mkdir(dirname(join(root, file)), { recursive: true });
				await writeFile(join(root, file), "");
				packages.push({ name, directory, areas: [{ behavior: "committed state", tests: [file] }] });
				testResults.push({ name: join(root, file), status: "passed", assertionResults: [{ status: "passed" }] });
			}
			if (scenario === "missing workspace") packages.pop();
			if (scenario === "empty area") packages[0].areas[0].tests = [];
			if (scenario === "foreign test") packages[0].areas[0].tests = ["outside/check.test.ts"];
			await json("docs/test-coverage.json", {
				description: "Owned behavior checks",
				packages,
				separateChecks: [],
				unverified: [],
			});
			const metric = { total: 1, covered: 1, skipped: 0, pct: 100 };
			const summary = {
				total: { lines: metric, branches: metric, functions: metric, statements: metric },
			};
			for (const directory of manifest.workspaces) summary[join(root, directory, "src/index.ts")] = summary.total;
			if (scenario === "unmeasured workspace") delete summary[join(root, manifest.workspaces[0], "src/index.ts")];
			await json("coverage/coverage-summary.json", summary);
			await json("coverage/test-results.json", {
				numPassedTests: testResults.length,
				numFailedTests: 0,
				numPendingTests: 0,
				testResults,
			});
			const execution = run(process.execPath, ["scripts/test-coverage.mjs"], { cwd: root });
			if (scenario === "complete") {
				await execution;
				const report = await readFile(join(root, "coverage/test-map.md"), "utf8");
				for (const pkg of packages) assert.ok(report.includes(`## ${pkg.name}`));
			} else {
				await assert.rejects(
					execution,
					(error) => error.code === 1 && /behavior.map|owned package tests|No measured source/.test(error.stderr),
				);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
