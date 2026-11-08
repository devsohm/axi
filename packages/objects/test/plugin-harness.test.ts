import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as api from "../src/index.ts";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { testPlugin } from "../src/node/plugins/index.ts";

test("the plugin harness collects contributions, exposes the host and closes its resources", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-plugin-harness-"));
	const plugin = join(directory, "greeting");
	await mkdir(plugin);
	await writeFile(join(plugin, "package.json"), JSON.stringify({ name: "greeting", type: "module" }));
	await writeFile(
		join(plugin, "worker.ts"),
		`
import { defineFacet, defineRegistry } from "@axi/objects";
const Greetings = defineRegistry("greetings", { version: 2 });
export default defineFacet((_host, self) => self.contribute(Greetings, { text: "hello" }));
`,
	);
	const Greetings = api.defineRegistry<{ text: string }, unknown>("greetings", { version: 2 });
	const missing = api.defineRegistry<string, unknown>("missing", { version: 1 });
	try {
		const loaded = await testPlugin(plugin, { kind: "worker", modules: { "@axi/objects": api } }, context);
		try {
			expect(loaded.plugin.name).toBe("greeting");
			expect(loaded.contributions(Greetings)).toEqual([{ plugin: "greeting", version: 2, value: { text: "hello" } }]);
			expect(loaded.unserved()).toEqual([]);
			expect(loaded.errors).toEqual([{ kind: "registry_undeclared", registry: "greetings", plugins: ["greeting"] }]);
			expect(await loaded.root(async () => "ready", context)).toBe("ready");
			expect(() => loaded.contributions(missing)).toThrow(/not collected/);
		} finally {
			await loaded.close(context);
		}
		await expect(loaded.root(async () => "late", context)).rejects.toThrow();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("the plugin harness reports discovery, build, evaluation and activation failures", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-plugin-failures-"));
	const plugin = join(directory, "broken.worker.ts");
	const options = { kind: "worker", modules: { "@axi/objects": api } };
	try {
		await writeFile(plugin, "export default {");
		await expect(testPlugin(plugin, options, context)).rejects.toThrow(/failed to build/);
		await writeFile(plugin, "throw new Error('evaluation failed');");
		await expect(testPlugin(plugin, options, context)).rejects.toThrow(/evaluation failed/);
		await writeFile(
			plugin,
			'import {defineFacet} from "@axi/objects"; export default defineFacet(() => {throw new Error("activation failed")});',
		);
		await expect(testPlugin(plugin, options, context)).rejects.toThrow(/setup failed.*activation failed/);
		await expect(testPlugin(directory, options, context)).rejects.toThrow(/no plugin/);
		await expect(testPlugin(plugin, { ...options, modules: { "app/v2": {} } }, context)).rejects.toThrow(/pass api/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
