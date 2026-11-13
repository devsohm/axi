import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { createHost, hostKind } from "../src/index.ts";
import { createPlugins } from "../src/node/plugins/index.ts";
import { tuiSurface, webSurface } from "../src/node/surfaces/index.ts";
import { contentHash } from "../src/node/plugins/base-inputs.ts";
import { PluginWatcher } from "../src/node/plugins/watcher.ts";
import { buildBase, processConditions } from "../src/node/surfaces/bundle.ts";
import { nodeBaseInputs } from "../src/node/workers/base.ts";
import { Batch } from "../src/state/internal.ts";

const roots: string[] = [],
	watchers: PluginWatcher[] = [];
afterEach(async () => {
	for (const watcher of watchers.splice(0)) watcher.close();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function project(files: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), "axi-base-"));
	roots.push(root);
	for (const [file, text] of Object.entries(files)) {
		await mkdir(join(root, file, ".."), { recursive: true });
		await writeFile(join(root, file), text);
	}
	return root;
}
function watch(base: readonly string[]) {
	const watcher = new PluginWatcher(
		{
			roots: [],
			base,
			kinds: [],
			failed(error) {
				throw error;
			},
		},
		new Batch(() => {}, undefined),
	);
	watchers.push(watcher);
	return watcher;
}

it("records the exact source and CSS bytes selected by explicit bundle conditions", async () => {
	const root = await project({
		"main.ts": 'import { value } from "sample"; import styles from "./a.module.css"; console.log(value, styles.row);',
		"a.module.css": ".row { color: red; }",
		"workspace/sample/package.json": JSON.stringify({
			name: "sample",
			exports: { source: "./source.ts", default: "./built.js" },
		}),
		"workspace/sample/source.ts": 'export const value: string = "source";',
		"workspace/sample/built.js": 'export const value = "built";',
	});
	await mkdir(join(root, "node_modules"));
	await symlink(join(root, "workspace/sample"), join(root, "node_modules/sample"));
	const base = await buildBase(join(root, "main.ts"), "browser", "/assets/", { conditions: ["source"] });
	expect([...base.inputs.keys()].sort()).toEqual(
		["main.ts", "a.module.css", "workspace/sample/source.ts"].map((name) => join(root, name)).sort(),
	);
	for (const [path, hash] of base.inputs)
		expect(hash).toBe(
			createHash("sha256")
				.update(await readFile(path))
				.digest("hex"),
		);
	expect(new TextDecoder().decode(base.files.get(base.script)!.bytes)).toContain('"source"');
	expect(base.style).toBeDefined();
	expect(
		processConditions(["-C", "source", "--conditions=edge"], '--conditions="development mode" -C "a\\"b"'),
	).toEqual(["development mode", 'a"b', "source", "edge"]);
});

it.each(["browser", "sandbox"] as const)("uses configured paths for a %s base and its surface", async (platform) => {
	const root = await project({
		"main.ts": 'import { label } from "@app/runtime/label"; console.log(label);',
		"runtime/label.ts": 'export const label = "source-alias";',
		"tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@app/runtime/*": ["./runtime/*.ts"] } } }),
	});
	const entry = join(root, "main.ts"), tsconfig = join(root, "tsconfig.json");
	const base = await buildBase(entry, platform, "/base/", { tsconfig });
	expect([...base.inputs.keys()].sort()).toEqual([entry, join(root, "runtime/label.ts")].sort());
	expect(new TextDecoder().decode(base.files.get(base.script)!.bytes)).toContain('"source-alias"');
	await expect(buildBase(entry, platform, "/base/", {})).rejects.toThrow('Could not resolve "@app/runtime/label"');
	const host = createHost({ address: hostKind("server")(), principal: { kind: "server" }, onError() {} });
	const plugins = createPlugins({ roots: [], kinds: {
		web: { platform: "browser", hostPackages: [] }, tui: { platform: "node", hostPackages: [] },
	}, onError() {} }, context);
	try {
		const surface = platform === "browser"
			? webSurface(host, { plugins, entry, tsconfig, routes: false })
			: tuiSurface(host, { plugins, entry, tsconfig });
		expect((await host.load([{ name: "view", facet: surface.facet }], context)).failed).toEqual([]);
		expect(await surface.build()).toMatchObject({ kind: "built", inputs: base.inputs });
	} finally {
		await host.close(context);
		plugins.close();
	}
});

it("scans static Node imports without executing code or requiring absent optional imports", async () => {
	const root = await project({
		"main.ts":
			'import "./present.ts"; if (false) await import("./absent.ts"); if (false) await import("optional-package"); throw new Error("must not run");',
		"present.ts": "export {};",
	});
	const inputs = await nodeBaseInputs(join(root, "main.ts"), []);
	expect([...inputs.keys()].sort()).toEqual([join(root, "main.ts"), join(root, "present.ts")]);
});

it("clears restart marks after edits revert, source files disappear and a moved directory returns", async () => {
	const root = await project({ "app/core.ts": "original" }),
		app = join(root, "app"),
		file = join(app, "core.ts");
	const separateBatches = async () => {
		if (process.platform === "darwin") await delay(300);
	};
	// macOS can combine fixture writes and watch registration in one FSEvents batch.
	await separateBatches();
	const watcher = watch([app]);
	await separateBatches();
	const marked = async (base: boolean, action: string) => {
		await vi.waitFor(() => expect(watcher.value, action).toMatchObject({ base }), { timeout: 5000 });
		await separateBatches();
	};
	await writeFile(file, "edited");
	await marked(true, "first edit");
	await writeFile(file, "original");
	await marked(false, "first revert");
	await writeFile(join(app, "extra.ts"), "new source");
	await marked(true, "added source file");
	await rm(join(app, "extra.ts"));
	await marked(false, "removed source file");
	await rename(app, join(root, "away"));
	await marked(true, "moved directory");
	await rename(join(root, "away"), app);
	await marked(false, "restored directory");
	await writeFile(file, "edited again");
	await marked(true, "edit after restoring directory");
	await writeFile(file, "original");
	await marked(false, "final revert");
}, 15000);

it("detects edits before attaching and preserves conflicting records of running bundles", async () => {
	const root = await project({ "file.ts": "later" }),
		file = join(root, "file.ts"),
		watcher = watch([]);
	await watcher.recordBase(new Map([[file, contentHash(Buffer.from("earlier"))]]));
	expect(watcher.value).toMatchObject({ base: true });
	await writeFile(file, "earlier");
	await vi.waitFor(() => expect(watcher.value).toMatchObject({ base: false }));
	await watcher.recordBase(new Map([[file, contentHash(Buffer.from("later"))]]));
	expect(watcher.value).toMatchObject({ base: true });
	await writeFile(file, "later");
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(watcher.value).toMatchObject({ base: true });
});

it("ignores source records delivered after the watcher closes", async () => {
	const root = await project({ "file.ts": "current" }),
		watcher = watch([]);
	watcher.close();
	await watcher.recordBase(new Map([[join(root, "file.ts"), contentHash(Buffer.from("old"))]]));
	expect(watcher.value).toMatchObject({ base: false });
});

it("does not publish a watch frame when a base rewrite leaves the bytes unchanged", async () => {
	const root = await project({ "unchanged.ts": "original" }),
		file = join(root, "unchanged.ts"),
		watcher = watch([root]);
	const watchHandle = await watcher.watch(context);
	const frames: unknown[] = [];
	watchHandle.start(async (frame) => {
		frames.push(frame);
	});
	const expected = new Map([[file, contentHash(Buffer.from("original"))]]);
	try {
		await watcher.recordBase(expected);
		await nextTurn();
		const initial = frames.length;
		const replacement = join(root, "replacement.tmp");
		await writeFile(replacement, "original");
		await rename(replacement, file);
		watcher.mark(file);
		await watcher.recordBase(expected);
		await nextTurn();
		expect(frames).toHaveLength(initial);
		await writeFile(file, "edited");
		watcher.mark(file);
		await watcher.recordBase(expected);
		await vi.waitFor(() => expect(frames.length).toBeGreaterThan(initial));
		expect(watcher.value).toMatchObject({ base: true });
	} finally {
		watchHandle.abort();
	}
});
