import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
const root = path.resolve(import.meta.dirname, "../..");
const result = await build({
	entryPoints: [path.join(import.meta.dirname, "worker.mjs")],
	bundle: true,
	write: false,
	format: "esm",
	platform: "node",
	target: "es2024",
	external: ["cloudflare:workers"],
	plugins: [
		{
			name: "compiled-wasm",
			setup(build) {
				build.onResolve({ filter: /\.wasm$/ }, () => ({ path: "./quickjs.wasm", external: true }));
			},
		},
	],
});
const directory = mkdtempSync(path.join(tmpdir(), "axi-workers-"));
const worker = path.join(directory, "worker.mjs"),
	wasm = path.join(directory, "quickjs.wasm");
writeFileSync(worker, result.outputFiles[0].contents);
writeFileSync(wasm, readFileSync(path.join(root, "node_modules/quickjs-wasi/quickjs.wasm")));
const mf = new Miniflare({
	modulesRoot: directory,
	modules: [
		{ type: "ESModule", path: worker },
		{ type: "CompiledWasm", path: wasm },
	],
	compatibilityDate: "2026-07-30",
	compatibilityFlags: ["nodejs_compat"],
	durableObjects: {
		STATE: { className: "State", useSQLite: true },
		SANDBOX: { className: "Sandbox", useSQLite: true },
	},
	durableObjectsPersist: path.join(directory, "storage"),
});
try {
	const receipts = [];
	for (let expected = 1; expected <= 2; expected++) {
		const response = await mf.dispatchFetch("https://check/");
		const text = await response.text();
		assert.equal(response.status, 200, text);
		const body = JSON.parse(text);
		assert.deepEqual(body.rows, [{ id: 1, value: "committed" }]);
		assert.deepEqual(body.binary, { typed: "010203", buffer: "0908010203070605" });
		assert.equal(body.rejected, true);
		assert.equal(body.count, expected);
		assert.equal(body.restored, expected);
		assert.equal(body.script.ok, true);
		assert.equal(body.script.value, 42);
		assert.deepEqual(body.script.output, [{ type: "text", text: "42" }]);
		assert.deepEqual(body.script.storeWrites, { set: { done: true }, delete: [] });
		assert.equal(body.remoteScript.ok, true);
		assert.equal(body.remoteScript.value, 42);
		assert.equal(body.agent.status, "done");
		assert.deepEqual(body.agent.reports, []);
		assert.equal(body.agent.toolResults.length, expected);
		assert.deepEqual(body.agent.toolResults.at(-1), [{ type: "text", text: "42" }]);
		receipts.push(body);
	}
	console.log(
		JSON.stringify({
			runtime: "workerd",
			requests: receipts.length,
			agentRuns: receipts.map((r) => r.agent.status),
			remoteValues: receipts.map((r) => r.remoteScript.value),
		}),
	);
} finally {
	await mf.dispose();
	rmSync(directory, { recursive: true, force: true });
}
