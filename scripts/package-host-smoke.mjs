import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as objects from "@axi/objects";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { AppInfo, Sessions, startServer } from "@axi/objects/app";
import { Http } from "@axi/objects/http";
import { startPage } from "@axi/objects/web";
import { HostProvider, useHold } from "@axi/objects/react";
import { pageScripts } from "@axi/objects/surfaces";
import { TuiScope } from "@axi/objects/tui";
import { filterOutput, requireSandboxNode, terminalFile } from "@axi/objects/tui/launcher";

assert.equal(typeof startPage, "function");
assert.equal(typeof HostProvider, "function");
assert.equal(typeof useHold, "function");
assert.equal(typeof pageScripts, "function");
assert.equal(typeof TuiScope, "function");
assert.equal(filterOutput("safe\x1b]52;c;c2VjcmV0\x07"), "safe");
assert.throws(() => requireSandboxNode("26.5.0"), /26.5.1/);
requireSandboxNode("26.5.1");
assert.equal(terminalFile("/_objects/tui/start", new URL("https://example.org")), "/_objects/tui/start");

const directory = await mkdtemp(join(tmpdir(), "axi-installed-app-"));
const root = join(directory, "plugins"),
	errors = [];
await mkdir(root);
const options = {
	name: "installed-app",
	root,
	dataDir: join(directory, "data"),
	api: { name: "@example/api", versions: ["v1"], modules: { "@example/api/v1": { ...objects, Http } } },
	kinds: { server: { platform: "node" } },
	principal: { server: { kind: "server" }, owner: { kind: "owner" } },
	onError: (error) => errors.push(error),
};
let app;
try {
	app = await startServer(options, context);
	const info = await app.host.get(AppInfo, {}, context);
	assert.equal(info.name.value, "installed-app");
	info.release();
	const sessions = await app.host.get(Sessions, {}, context);
	const device = await sessions.issue({ principal: { kind: "owner" }, label: "installed", kind: "device" }, context);
	assert.deepEqual(await sessions.verify(device.token, context), { kind: "owner" });
	sessions.release();
	const owner = await readFile(app.ownerTokenFile, "utf8");
	await app.close(context);
	app = await startServer(options, context);
	assert.equal(await readFile(app.ownerTokenFile, "utf8"), owner);
	const restored = await app.host.get(Sessions, {}, context);
	assert.deepEqual(await restored.verify(device.token, context), { kind: "owner" });
	await restored.revoke(device.id, context);
	assert.equal(await restored.verify(device.token, context), null);
	restored.release();
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ installedApp: true, sessionsRestored: true, clientImports: true }));
} finally {
	await app?.close(context);
	await rm(directory, { recursive: true, force: true });
}
