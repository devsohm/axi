import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { createPlugins } from "../../src/node/plugins/plugins.ts";

const root = await mkdtemp(join(tmpdir(), "axi-plugin-lifetime-"));
const directory = join(root, "sample");
await mkdir(directory);
await writeFile(join(directory, "package.json"), JSON.stringify({ name: "sample" }));
await writeFile(join(directory, "server.ts"), "export default { setup() {} };");
const plugins = createPlugins(
	{ roots: [root], kinds: { server: { platform: "node", hostPackages: [] } }, onError() {} },
	context,
);
try {
	const remember = async () => new WeakRef((await plugins.build([], context)).facets[0]);
	const built = await remember();
	await rm(directory, { recursive: true });
	for (let count = 0; !plugins.state.value.set && count < 200; count++) await setTimeout(5);
	assert.deepEqual((await plugins.build([], context)).removed, ["sample"]);
	for (let count = 0; count < 6; count++) {
		await setImmediate();
		globalThis.gc();
	}
	assert.equal(built.deref(), undefined, "A removed plugin's build must be collectible");
} finally {
	plugins.close();
	await rm(root, { recursive: true, force: true });
}
