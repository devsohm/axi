import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const targets = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64", "windows-arm64"];
const source = "packages/sample/src/choose.ts";
const code = "export function choose(flag) {\n  if (flag) return 1;\n  return 2;\n}\n";
const location = (line) => ({ start: { line, column: 0 }, end: { line, column: 20 } });
const json = async (file, data) => {
	await mkdir(join(file, ".."), { recursive: true });
	await writeFile(file, JSON.stringify(data));
};
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "axi-platform-coverage-"));
	await mkdir(join(directory, "scripts"));
	await copyFile(join(root, "scripts/coverage-platforms.mjs"), join(directory, "scripts/coverage-platforms.mjs"));
	await copyFile(join(root, "scripts/coverage-provider.mjs"), join(directory, "scripts/coverage-provider.mjs"));
	await copyFile(join(root, "scripts/coverage-node.mjs"), join(directory, "scripts/coverage-node.mjs"));
	await copyFile(join(root, "scripts/coverage-instrument.ts"), join(directory, "scripts/coverage-instrument.ts"));
	await symlink(
		join(root, "node_modules"),
		join(directory, "node_modules"),
		process.platform === "win32" ? "junction" : "dir",
	);
	await json(join(directory, "package.json"), { workspaces: ["packages/sample"] });
	await writeFile(join(directory, "vitest.config.ts"), 'export default { test: { coverage: { autoAttachSubprocess: true } } };');
	await mkdir(join(directory, source, ".."), { recursive: true });
	await writeFile(join(directory, source), code);
	for (const [index, target] of targets.entries()) {
		// Counter IDs vary between reports; source positions identify the same executable code.
		const id = String(index * 10),
			branch = index < 3 ? [1, 0] : [0, 1];
		await json(join(directory, "artifacts", target, "coverage-portable.json"), {
			[source]: {
				path: source,
				statementMap: { [id]: location(2), [Number(id) + 1]: location(3) },
				s: { [id]: branch[0], [Number(id) + 1]: branch[1] },
				fnMap: { [id]: { name: "choose", decl: location(1), loc: location(1), line: 1 } },
				f: { [id]: 1 },
				branchMap: { [id]: { type: "if", loc: location(2), locations: [location(2), location(3)], line: 2 } },
				b: { [id]: branch },
			},
		});
		await json(join(directory, "artifacts", target, "coverage-platform.json"), {
			version: 1,
			target,
			commit: "same-commit",
			instrumentation: { vitest: "fixture", provider: "fixture" },
			sources: { [source]: createHash("sha256").update(code).digest("hex") },
			passed: 1,
			skipped: 0,
		});
	}
	return directory;
}

test("native reports merge by source position while preserving both branches and exact hit totals", async () => {
	const directory = await fixture();
	try {
		await run(process.execPath, ["scripts/coverage-platforms.mjs", "merge", "artifacts", "combined"], {
			cwd: directory,
		});
		const summary = JSON.parse(await readFile(join(directory, "combined/coverage-summary.json")));
		assert.equal(summary.total.lines.pct, 100);
		assert.equal(summary.total.branches.covered, 2);
		const coverage = JSON.parse(await readFile(join(directory, "combined/coverage-final.json")));
		const file = coverage[join(directory, source)];
		assert.deepEqual(Object.values(file.s), [3, 3]);
		assert.deepEqual(Object.values(file.b), [[3, 3]]);
		assert.deepEqual(Object.values(file.f), [6]);
		assert.equal(JSON.parse(await readFile(join(directory, "combined/platforms.json"))).length, 6);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

for (const [scenario, diagnostic] of [
	["missing target", /Expected one successful/],
	["duplicate target", /Expected one successful/],
	["changed source", /same sources and instrumentation/],
	["different commit", /same sources and instrumentation/],
	["different instrumentation", /same sources and instrumentation/],
	["different counters", /counter maps differ/],
	["foreign path", /Invalid coverage source path/],
	["missing module", /lacks passing tests or workspace source modules/],
	["no passing tests", /lacks passing tests or workspace source modules/],
])
	test(`native coverage refuses ${scenario} instead of reporting a combined percentage`, async () => {
		const directory = await fixture();
		try {
			const metadata = join(directory, "artifacts/windows-arm64/coverage-platform.json");
			const coverage = join(directory, "artifacts/windows-arm64/coverage-portable.json");
			const record = JSON.parse(await readFile(metadata));
			if (scenario === "missing target") await rm(metadata);
			if (scenario === "duplicate target") {
				record.target = targets[0];
				await json(metadata, record);
			}
			if (scenario === "changed source") await writeFile(join(directory, source), code + "// changed\n");
			if (scenario === "different commit") {
				record.commit = "other-commit";
				await json(metadata, record);
			}
			if (scenario === "different instrumentation") {
				record.instrumentation.provider = "other";
				await json(metadata, record);
			}
			if (scenario === "different counters") {
				const files = JSON.parse(await readFile(coverage));
				Object.values(files[source].statementMap)[0].end.column++;
				await json(coverage, files);
			}
			if (scenario === "foreign path") await json(coverage, { "../outside.ts": {} });
			if (scenario === "missing module") await json(coverage, {});
			if (scenario === "no passing tests") {
				record.passed = 0;
				await json(metadata, record);
			}
			await assert.rejects(
				run(process.execPath, ["scripts/coverage-platforms.mjs", "merge", "artifacts", "combined"], { cwd: directory }),
				(error) => error.code === 1 && diagnostic.test(error.stderr),
			);
			await assert.rejects(readFile(join(directory, "combined/coverage-summary.json")), { code: "ENOENT" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

test("coverage capture rejects a failed suite and records source identities only after a passing suite", async () => {
	const directory = await fixture();
	try {
		await run("git", ["init", "--quiet"], { cwd: directory });
		await run("git", ["add", "package.json", source], { cwd: directory });
		await run(
			"git",
			["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"],
			{ cwd: directory },
		);
		const files = JSON.parse(await readFile(join(directory, "artifacts/linux-x64/coverage-portable.json")));
		await json(join(directory, "coverage/coverage-final.json"), {
			[join(directory, source)]: { ...files[source], path: join(directory, source) },
		});
		await json(join(directory, "coverage/test-results.json"), { success: false, numFailedTests: 1 });
		await assert.rejects(
			run(process.execPath, ["scripts/coverage-platforms.mjs", "capture"], { cwd: directory }),
			(error) => error.stderr.includes("failed test run"),
		);
		await json(join(directory, "coverage/test-results.json"), {
			success: true,
			numFailedTests: 0,
			numFailedTestSuites: 0,
			numPassedTests: 1,
			numPendingTests: 0,
		});
		await run(process.execPath, ["scripts/coverage-platforms.mjs", "capture"], { cwd: directory });
		const record = JSON.parse(await readFile(join(directory, "coverage/coverage-platform.json")));
		assert.equal(record.passed, 1);
		assert.equal(record.instrumentation.transformer, JSON.parse(await readFile(join(root, "node_modules/esbuild/package.json"))).version);
		assert.match(record.commit, /^[a-f\d]{40}$/);
		assert.equal(record.instrumentation.configuration, createHash("sha256").update(await readFile(join(directory, "vitest.config.ts"))).digest("hex"));
		assert.equal(record.instrumentation.collector, createHash("sha256").update(await readFile(join(directory, "scripts/coverage-provider.mjs"))).digest("hex"));
		assert.deepEqual(Object.keys(record.sources), [source]);
		assert.deepEqual(Object.keys(JSON.parse(await readFile(join(directory, "coverage/coverage-portable.json")))), [
			source,
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
