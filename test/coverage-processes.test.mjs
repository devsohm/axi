import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { bundleCoverage } from "../scripts/coverage-instrument.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

test("bundle coverage records executed source and rejects unrelated report paths", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-bundle-coverage-"));
	try {
		const source = join(directory, "packages/sample/src/probe.ts");
		const output = join(directory, "reports");
		await mkdir(join(source, ".."), { recursive: true });
		await mkdir(output);
		await writeFile(
			source,
			"export function choose(flag: boolean) { if (flag) return 41; return -1; }\nexport function unused() { return 0; }\n",
		);
		const collector = bundleCoverage(output);
		const bundle = await build({
			entryPoints: [source],
			bundle: true,
			write: false,
			globalName: "fixture",
			plugins: [collector.plugin],
		});
		const context = Object.create(null);
		runInNewContext(bundle.outputFiles[0].text, context);
		assert.equal(context.fixture.choose(true), 41);
		collector.write(context.__VITEST_COVERAGE__);
		const files = await readdir(output);
		assert.equal(files.length, 1);
		const report = JSON.parse(await readFile(join(output, files[0]), "utf8"))[source];
		assert.ok(report.inputSourceMap);
		const functions = Object.entries(report.fnMap);
		assert.equal(report.f[functions.find(([, fn]) => fn.name === "choose")[0]], 1);
		assert.equal(report.f[functions.find(([, fn]) => fn.name === "unused")[0]], 0);
		assert.deepEqual(Object.values(report.b), [[1, 0]]);
		assert.throws(() => collector.write({ [join(directory, "foreign.ts")]: {} }), /Unexpected bundle coverage/);
		assert.equal((await readdir(output)).length, 1);
		assert.throws(() => bundleCoverage(undefined).write({}), /Bundle coverage is disabled/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("coverage keeps parent, child and worker execution separate before crediting source branches", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-process-coverage-"));
	try {
		await mkdir(join(directory, "src"));
		await mkdir(join(directory, "test"));
		await symlink(
			join(root, "node_modules"),
			join(directory, "node_modules"),
			process.platform === "win32" ? "junction" : "dir",
		);
		await writeFile(join(directory, "package.json"), '{"type":"module"}');
		for (const [file, value] of [
			["child", 41],
			["worker", 17],
		]) {
			await writeFile(
				join(directory, "src", file + ".ts"),
				`export function choose(flag: boolean): number {\n  if (flag) return arrow(${value});\n  return arrow(-1);\n}\nexport function unused() { return 0; }\nconst arrow = (value: number): number => value;\nexport const load = () => Promise.resolve().then(() => import("./target.ts"));\nexport function cleanup() { return -1; }\n`,
			);
		}
		await writeFile(join(directory, "src/target.ts"), "export const value = 23;");
		await writeFile(
			join(directory, "test/child.mjs"),
			'import { choose, load, cleanup } from "../src/child.ts"; process.on("exit", cleanup); await load(); (await import("../src/child.ts?reload")).choose(true); process.emitWarning("fixture application warning"); console.log(choose(true));',
		);
		await writeFile(
			join(directory, "test/worker.mjs"),
			'import { parentPort } from "node:worker_threads"; import { choose, load, cleanup } from "../src/worker.ts"; process.on("exit", cleanup); await load(); parentPort.postMessage(choose(true));',
		);
		await writeFile(
			join(directory, "test/run.test.ts"),
			`
import { execFile } from "node:child_process";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { choose as chooseChild, load as loadChild } from "../src/child.ts";
import { choose as chooseWorker, load as loadWorker } from "../src/worker.ts";
test("real child and worker execute", async () => {
  expect((await loadChild()).value).toBe(23);
  expect((await loadWorker()).value).toBe(23);
  expect(chooseChild(false)).toBe(-1);
  expect(chooseWorker(false)).toBe(-1);
  const child = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./child.mjs", import.meta.url))]);
  expect(child.stdout.trim()).toBe("41");
  expect(child.stderr).toContain("fixture application warning");
  expect(child.stderr).not.toContain("stripTypeScriptTypes");
  const worker = new Worker(new URL("./worker.mjs", import.meta.url));
  const exited = once(worker, "exit");
  expect((await once(worker, "message"))[0]).toBe(17);
  expect((await exited)[0]).toBe(0);
});`,
		);
		const maps = new Map();
		for (const enabled of [false, true]) {
			await writeFile(
				join(directory, "vitest.config.mjs"),
				`import { typescriptSources } from ${JSON.stringify(join(root, "scripts/coverage-provider.mjs"))}; export default { esbuild: false, oxc: false, plugins: [typescriptSources], test: { include: ["test/*.test.ts"], env: { AXI_COVERAGE_ATTACH: "${enabled ? 1 : 0}" }, coverage: { provider: "custom", customProviderModule: ${JSON.stringify(join(root, "scripts/coverage-provider.mjs"))}, include: ["src/**/*.ts"], reporter: ["json"] } } };`,
			);
			await run(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "--coverage"], {
				cwd: directory,
				timeout: 30000,
				maxBuffer: 1024 * 1024,
			});
			const report = JSON.parse(await readFile(join(directory, "coverage/coverage-final.json"), "utf8"));
			for (const name of ["child", "worker"]) {
				const file = report[join(directory, "src", name + ".ts")];
				assert.ok(file, `Missing ${name} source module`);
				const map = { statements: file.statementMap, functions: file.fnMap, branches: file.branchMap };
				if (enabled) assert.deepEqual(map, maps.get(name), `${name}: each source counter is counted once`);
				else maps.set(name, map);
				const functions = Object.entries(file.fnMap);
				assert.equal(functions.length, 6);
				const choose = functions.find(([, entry]) => entry.name === "choose");
				const unused = functions.find(([, entry]) => entry.name === "unused");
				assert.ok(choose && unused);
				assert.equal(
					file.f[choose[0]],
					enabled ? (name === "child" ? 3 : 2) : 1,
					`${name}: each invocation counted once`,
				);
				assert.equal(file.f[unused[0]], 0, `${name}: unexecuted function`);
				const cleanup = functions.find(([, entry]) => entry.name === "cleanup");
				assert.equal(file.f[cleanup[0]], enabled ? 1 : 0, `${name}: exit handlers are counted`);
				const branch = Object.entries(file.branchMap).find(([, entry]) => entry.type === "if");
				assert.ok(branch);
				assert.equal(file.b[branch[0]][0] > 0, enabled, `${name}: selected branch`);
				assert.ok(file.b[branch[0]][1] > 0, `${name}: parent branch`);
			}
		}
		const child = join(directory, "test/child.mjs");
		await writeFile(
			child,
			(await readFile(child, "utf8")) +
				`
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import MagicString from "magic-string";
const filename = ${JSON.stringify(join(directory, "src/child.ts"))};
const report = structuredClone(globalThis.__VITEST_COVERAGE__[filename]);
report.statementMap[0].start.column++;
report.inputSourceMap = new MagicString(readFileSync(filename, "utf8")).generateMap({ source: filename, includeContent: true, hires: true });
writeFileSync(join(process.env.AXI_COVERAGE_DIRECTORY, process.pid + "-incompatible.json"), JSON.stringify({[filename]:report}));`,
		);
		await assert.rejects(
			run(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "--coverage"], {
				cwd: directory,
				timeout: 30000,
				maxBuffer: 1024 * 1024,
			}),
			(error) => error.code === 1 && error.stderr.includes("Child coverage maps differ:"),
		);
		await assert.rejects(readFile(join(directory, "coverage/coverage-final.json")), { code: "ENOENT" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
