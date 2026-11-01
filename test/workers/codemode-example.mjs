import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const root = path.resolve(import.meta.dirname, "../..");
const example = path.join(root, "packages/codemode/examples/cloudflare");
const directory = mkdtempSync(path.join(tmpdir(), "axi-codemode-example-"));
let runtime;
try {
	const workers = [];
	for (const name of ["agent", "sandbox"]) {
		const config = JSON.parse(readFileSync(path.join(example, name, "wrangler.jsonc")));
		const bundled = await build({
			entryPoints: [path.join(example, name, config.main)],
			bundle: true,
			write: false,
			format: "esm",
			platform: "neutral",
			target: "es2024",
			external: ["cloudflare:workers"],
			plugins: [
				{
					name: "compiled-wasm",
					setup(builder) {
						builder.onResolve({ filter: /\.wasm$/ }, () => ({ path: "./quickjs.wasm", external: true }));
					},
				},
			],
		});
		const script = path.join(directory, name + ".mjs");
		writeFileSync(script, bundled.outputFiles[0].contents);
		const modules = [{ type: "ESModule", path: script }];
		if (name === "sandbox") {
			const wasm = path.join(directory, "quickjs.wasm");
			writeFileSync(wasm, readFileSync(path.join(root, "node_modules/quickjs-wasi/quickjs.wasm")));
			modules.push({ type: "CompiledWasm", path: wasm });
		}
		workers.push({
			name: config.name,
			modulesRoot: directory,
			modules,
			compatibilityDate: config.compatibility_date,
			durableObjects: Object.fromEntries(
				(config.durable_objects?.bindings ?? []).map((binding) => [
					binding.name,
					{
						className: binding.class_name,
						useSQLite: true,
						...(binding.script_name ? { scriptName: binding.script_name } : {}),
					},
				]),
			),
		});
	}
	runtime = new Miniflare({ workers });
	assert.equal((await runtime.dispatchFetch("https://example/")).status, 405);
	for (const expected of [2, 4]) {
		const response = await runtime.dispatchFetch("https://example/", {
			method: "POST",
			body: "const value=await tools.count({add:2});text(value);return value;",
		});
		assert.equal(response.status, 200);
		const result = await response.json();
		assert.equal(result.ok, true);
		assert.equal(result.value, expected);
		assert.deepEqual(result.output, [{ type: "text", text: String(expected) }]);
		assert.equal(result.calls[0].name, "count");
		assert.equal(result.calls[0].status, "ok");
	}
	console.log(
		JSON.stringify({
			runtime: "workerd",
			example: "codemode",
			workers: workers.map((worker) => worker.name),
			values: [2, 4],
		}),
	);
} finally {
	await runtime?.dispose();
	rmSync(directory, { recursive: true, force: true });
}
