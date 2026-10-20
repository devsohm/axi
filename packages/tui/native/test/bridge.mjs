import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const source = fileURLToPath(new URL("./clipboard-fixture.c", import.meta.url));
const headers =
	process.env.NODE_INCLUDE_DIR ??
	["/usr/include/node", resolve(dirname(process.execPath), "../include/node")].find((path) =>
		existsSync(join(path, "node_api.h")),
	);
test("Node-API clipboard bridge transfers values and propagates errors", { skip: !headers, timeout: 15000 }, () => {
	const directory = mkdtempSync(join(tmpdir(), "axi-clipboard-"));
	const binary = join(directory, "clipboard-fixture.node");
	try {
		let compiler = process.env.CC ?? "cc";
		let args = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-shared", "-fPIC", `-I${headers}`, source, "-o", binary];
		if (process.platform === "darwin") args.push("-undefined", "dynamic_lookup");
		if (process.platform === "win32") {
			compiler = process.env.CC ?? "cl";
			assert.ok(process.env.NODE_IMPORT_LIBRARY, "Set NODE_IMPORT_LIBRARY to node.lib");
			args = ["/nologo", "/LD", `/I${headers}`, source, process.env.NODE_IMPORT_LIBRARY, "/link", `/OUT:${binary}`];
		}
		const build = spawnSync(compiler, args, { cwd: directory, stdio: "inherit" });
		if (build.error) throw build.error;
		assert.equal(build.status, 0);
		const result = spawnSync(
			process.execPath,
			[
				"-e",
				`
            const assert = require('node:assert/strict');
            const helper = require(process.argv[1]);
            (async () => {
                assert.equal(await helper.getText(), 'café');
                assert.deepEqual(await helper.getImage(), Buffer.from([0, 127, 255]));
                assert.deepEqual(await helper.getFilePaths(), ['/one', '/two']);
                assert.equal(await helper.setText('café'), undefined);
                assert.throws(() => helper.setText(3), /requires a string/);
                await assert.rejects(helper.setText('wrong'), /Unexpected text/);
            })().catch(error => { console.error(error); process.exitCode = 1; });
        `,
				binary,
			],
			{ stdio: "inherit", timeout: 10000 },
		);
		if (result.error) throw result.error;
		assert.equal(result.status, 0);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
