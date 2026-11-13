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

for (const [args, expected] of [
	[["--gaps", "main.ts", "2"], "function submit"],
	[["--gaps", "absent", "2"], "0 uncovered locations"],
	[["--gaps", "main.ts", "50"], "<unmapped>"],
	[["--gaps", "main.ts", "51"], "invalid negative counter"],
	[["--gaps", "main.ts", "0"], "Coverage gap limit must be a positive integer"],
])
	test(`coverage gap command handles ${args.join(" ")}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "axi-coverage-gaps-"));
		try {
			for (const directory of ["scripts", "coverage", "packages/sample/src"])
				await mkdir(join(root, directory), { recursive: true });
			await copyFile(
				new URL("../scripts/coverage-summary.mjs", import.meta.url),
				join(root, "scripts/coverage-summary.mjs"),
			);
			await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/sample"] }));
			await writeFile(join(root, "packages/sample/package.json"), JSON.stringify({ name: "@axi/sample" }));
			const file = join(root, "packages/sample/src/main.ts");
			await writeFile(file, "function submit() {}\nif (flag) submit();\nelse fallback();\n");
			const metric = { total: 2, covered: 1, skipped: 0, pct: 50 };
			await writeFile(
				join(root, "coverage/coverage-summary.json"),
				JSON.stringify({ [file]: { lines: metric, functions: metric, branches: metric } }),
			);
			const location = (line) => ({ start: { line, column: 0 }, end: { line, column: 10 } });
			await writeFile(
				join(root, "coverage/coverage-final.json"),
				JSON.stringify({
					[file]: {
						s: { 0: 0 },
						statementMap: { 0: location(3) },
						f: { 0: 0 },
						fnMap: { 0: { name: "submit", decl: location(1) } },
						b: { 0: [0, 1], 3: [2, -1], ...(args.at(-1) === "50" ? { 1: [0], 2: [0] } : {}) },
						branchMap: {
							0: { locations: [location(2), location(3)] },
							3: { locations: [location(2), location(3)] },
							...(args.at(-1) === "50"
								? { 1: { locations: [location(0)], loc: location(3) }, 2: { locations: [location(0)] } }
								: {}),
						},
					},
				}),
			);
			const execution = run(process.execPath, ["scripts/coverage-summary.mjs", ...args], { cwd: root });
			if (args.at(-1) === "0")
				await assert.rejects(execution, (error) => error.code === 1 && error.stderr.includes(expected));
			else {
				const { stdout } = await execution;
				assert.ok(stdout.includes(expected));
				if (args[1] === "main.ts" && args.at(-1) === "2") {
					assert.ok(stdout.includes("if (flag) submit();"));
					assert.ok(!stdout.includes("else fallback();"));
				}
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

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
