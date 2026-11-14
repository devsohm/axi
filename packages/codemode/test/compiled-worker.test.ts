import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, test } from "vitest";
import { bundleCoverage } from "../../../scripts/coverage-instrument.ts";

test("a compiled sandbox locates its JavaScript worker and returns reusable store writes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-compiled-sandbox-"));
	const collector = bundleCoverage(process.env.AXI_COVERAGE_DIRECTORY);
	try {
		await symlink(
			fileURLToPath(new URL("../../../node_modules", import.meta.url)),
			join(directory, "node_modules"),
			process.platform === "win32" ? "junction" : "dir",
		);
		await writeFile(join(directory, "package.json"), '{"type":"module"}');
		await build({
			entryPoints: {
				host: fileURLToPath(new URL("../src/runtime/host.ts", import.meta.url)),
				worker: fileURLToPath(new URL("../src/runtime/worker.ts", import.meta.url)),
			},
			outdir: directory,
			bundle: true,
			format: "esm",
			platform: "node",
			packages: "external",
			plugins: [collector.plugin],
		});
		await writeFile(
			join(directory, "run.mjs"),
			`
import { CodemodeSandbox } from "./host.js";
const exits = [];
const deadline = setTimeout(() => { throw new Error("Workers did not stop"); }, 10000);
const sandbox = new CodemodeSandbox({
  tools: [{ name: "double", execute: ({ value }) => value * 2 }],
  onWorkerStarted: (exited) => exits.push(exited),
});
try {
  const first = await sandbox.execute('const value = await tools.double({value: 21}); store("answer", value); return value;');
  if (!first.ok) throw new Error(JSON.stringify(first));
  const second = await sandbox.execute('return load("answer");', { store: first.storeWrites.set });
  await sandbox.close();
  await Promise.all(exits);
  console.log(JSON.stringify({ first, second, coverage: globalThis.__VITEST_COVERAGE__ ?? {} }));
} finally {
  await sandbox.close();
  clearTimeout(deadline);
}
`,
		);
		const result = await promisify(execFile)(process.execPath, [join(directory, "run.mjs")], {
			timeout: 15000,
			maxBuffer: 4 * 1024 * 1024,
		});
		const { first, second, coverage } = JSON.parse(result.stdout);
		expect(first).toMatchObject({ ok: true, value: 42, calls: [{ name: "double", status: "ok" }] });
		expect(second).toMatchObject({ ok: true, value: 42, calls: [] });
		if (process.env.AXI_COVERAGE_DIRECTORY) collector.write(coverage);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);
