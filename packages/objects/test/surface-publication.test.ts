import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { createHost, hostKind, WebScripts } from "../src/index.ts";
import { createHttp } from "../src/node/http/index.ts";
import { createPlugins } from "../src/node/plugins/index.ts";
import { buildBase, pageBootstrap, pageScripts, WEB_PREFIX, webSurface } from "../src/node/surfaces/index.ts";

it("collects base assets and exposes a surface without installing HTTP routes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-surface-assets-"));
	const root = join(directory, "plugins"),
		entry = join(directory, "main.ts");
	await mkdir(root);
	await writeFile(entry, 'import "./theme.css"; import wasm from "./module.wasm"; globalThis.moduleUrl = wasm;');
	await writeFile(
		join(directory, "theme.css"),
		'@font-face{font-family:Local;src:url("./local.woff2")} .logo{background:url("./local.png")}',
	);
	const assets = [
		{ name: "local.woff2", mime: "font/woff2", bytes: Buffer.from("font payload") },
		{ name: "local.png", mime: "image/png", bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
		{ name: "module.wasm", mime: "application/wasm", bytes: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]) },
	];
	for (const asset of assets) await writeFile(join(directory, asset.name), asset.bytes);
	const host = createHost({ address: hostKind("server")(), principal: { kind: "server" }, onError() {} });
	const plugins = createPlugins(
		{ roots: [root], kinds: { web: { platform: "browser", hostPackages: [] } }, onError() {} },
		context,
	);
	const http = createHttp(host, { onError() {} }, context);
	try {
		const base = await buildBase(entry, "browser", WEB_PREFIX, { conditions: [] });
		const emitted = [...base.files].filter(([path]) => path.startsWith(`${WEB_PREFIX}assets/`));
		expect(emitted).toHaveLength(assets.length);
		for (const asset of assets) {
			const output = emitted.find(([path]) => path.endsWith(`.${asset.name.split(".").at(-1)}`));
			expect(output?.[1].mime).toBe(asset.mime);
			expect(Buffer.from(output![1].bytes)).toEqual(asset.bytes);
		}
		const css = new TextDecoder().decode(base.files.get(base.style!)!.bytes);
		for (const [path] of emitted.filter(([path]) => !path.endsWith(".wasm"))) expect(css).toContain(path);
		const surface = webSurface(host, { plugins, entry, conditions: [], routes: false });
		expect(
			(
				await host.load(
					[
						{ name: "http", facet: http.facet },
						{ name: "web", facet: surface.facet },
					],
					context,
				)
			).failed,
		).toEqual([]);
		expect(await surface.base()).toBe(base.hash);
		const scripts = await host.get(WebScripts, {}, context);
		try {
			const page = await surface.pageAssets();
			expect(page).toEqual({
				bootstrap: pageBootstrap(base.hash, scripts.set.value),
				script: base.script,
				plugins: scripts.set.value.combined,
				styles: [base.style],
			});
			const file = await surface.file(base.script);
			expect(file.kind).toBe("bytes");
			if (file.kind !== "bytes") throw new Error("Expected built JavaScript");
			expect(file.mime).toBe("text/javascript; charset=utf-8");
			const expected = base.files.get(base.script)!.bytes;
			expect(file.size).toBe(expected.length);
			expect(await host.root((ctx) => file.read(0, expected.length, ctx), context)).toEqual(expected);
			expect(await surface.file(`${WEB_PREFIX}missing.js`)).toEqual({ kind: "error", status: 404 });
			for (const path of ["/", base.script, `${WEB_PREFIX}base`]) {
				const response = await http.fetch(new Request(`http://127.0.0.1${path}`, { headers: { host: "127.0.0.1" } }), {
					localAddress: "127.0.0.1",
					localPort: 80,
				});
				expect(response.status).toBe(404);
			}
		} finally {
			scripts.release();
		}
	} finally {
		await http.close(context);
		await host.close(context);
		plugins.close();
		await rm(directory, { recursive: true, force: true });
	}
});

it("publishes plugin changes while retaining working assets after a failed replacement", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-published-"));
	const root = join(directory, "plugins"),
		card = join(root, "card");
	await mkdir(card, { recursive: true });
	await writeFile(join(card, "package.json"), JSON.stringify({ name: "@example/card", type: "module" }));
	await writeFile(
		join(card, "web.ts"),
		`import icon from "./mark.svg?url";
import "./screen.css";
export default { setup() { return icon; } };`,
	);
	await writeFile(join(card, "mark.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="8"/>');
	await writeFile(join(card, "screen.css"), ".card { color: purple; }");
	const entry = join(directory, "main.ts");
	await writeFile(entry, "globalThis.applicationStarted = true;");
	const host = createHost({ address: hostKind("server")(), principal: { kind: "server" }, onError() {} });
	const plugins = createPlugins(
		{
			roots: [root],
			kinds: { web: { platform: "browser", hostPackages: [] } },
			publicPath: `${WEB_PREFIX}assets/`,
			onError() {},
		},
		context,
	);
	const http = createHttp(host, { onError() {} }, context);
	try {
		const surface = webSurface(host, {
			plugins,
			entry,
			public: true,
			page: (request, assets) => pageScripts(assets, request.nonce),
		});
		expect(
			(
				await host.load(
					[
						{ name: "http", facet: http.facet },
						{ name: "web", facet: surface.facet },
					],
					context,
				)
			).failed,
		).toEqual([]);
		const request = (path: string) =>
			http.fetch(new Request(`http://127.0.0.1${path}`, { headers: { host: "127.0.0.1" } }), {
				localAddress: "127.0.0.1",
				localPort: 80,
			});
		expect((await surface.build()).kind).toBe("built");
		const scripts = await host.get(WebScripts, {}, context);
		try {
			const initial = scripts.set.value;
			expect(initial.plugins.map(({ name }) => name)).toEqual(["@example/card"]);
			const cardScript = initial.plugins[0]!;
			const standalone = await request(cardScript.url),
				source = await standalone.text();
			expect(standalone.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
			expect(source).toContain("sourceMappingURL");
			expect(await (await request(initial.combined)).text()).not.toContain("sourceMappingURL");
			if (cardScript.css === undefined) throw new Error("Plugin stylesheet missing");
			expect(await (await request(cardScript.css)).text()).toContain("purple");
			const assetUrl = source.match(/"([^"\n]*\/assets\/mark-[^"\n]+\.svg)"/)?.[1];
			if (assetUrl === undefined) throw new Error("Plugin asset missing");
			const image = await request(assetUrl),
				imageBytes = await image.text();
			expect(image.headers.get("content-type")).toBe("image/svg+xml");
			expect(imageBytes).toContain('width="8"');
			expect(image.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");

			const badge = join(root, "badge");
			await mkdir(badge);
			await writeFile(join(badge, "package.json"), JSON.stringify({ name: "@example/badge", type: "module" }));
			await writeFile(join(badge, "web.ts"), "export default { setup() { return 1; } };");
			const rollout = async (names: string[]) => {
				const built = await plugins.build(names, context);
				const result = await plugins.rollout([surface.step("web")], built, context);
				expect(result.stopped).toBeUndefined();
				const report = result.steps[0]?.hosts[0];
				if (report === undefined || !("report" in report)) throw new Error("Publication failed");
				return report.report;
			};
			expect((await rollout(["@example/badge"])).plugins).toEqual({
				added: ["@example/badge"],
				changed: [],
				removed: [],
			});
			expect(scripts.set.value.plugins.map(({ name }) => name)).toEqual(["@example/badge", "@example/card"]);
			await writeFile(join(card, "screen.css"), ".card { color: orange; }");
			expect((await rollout(["@example/card"])).plugins.changed).toEqual(["@example/card"]);
			const working = scripts.set.value.plugins.find(({ name }) => name === "@example/card")!;
			expect(working.css).not.toBe(cardScript.css);
			expect(await (await request(working.css!)).text()).toContain("orange");
			await writeFile(join(card, "web.ts"), "export default = ;");
			for (let revision = 2; revision <= 6; revision++) {
				await writeFile(join(badge, "web.ts"), `export default { setup() { return ${revision}; } };`);
				const report = await rollout(["@example/card", "@example/badge"]);
				expect(report.failed.map(({ plugin }) => plugin)).toEqual(["@example/card"]);
				expect(report.plugins.changed).toEqual(["@example/badge"]);
				expect(scripts.set.value.plugins.find(({ name }) => name === "@example/card")).toEqual(working);
				expect(await (await request(assetUrl)).text()).toBe(imageBytes);
				expect(await (await request(working.css!)).text()).toContain("orange");
			}
			expect((await request(initial.combined)).status).toBe(404);
			await rm(card, { recursive: true });
			expect((await rollout(["@example/card"])).plugins.removed).toEqual(["@example/card"]);
			expect(scripts.set.value.plugins.map(({ name }) => name)).toEqual(["@example/badge"]);
			expect((await request(`${WEB_PREFIX}missing.js`)).status).toBe(404);
		} finally {
			scripts.release();
		}
	} finally {
		await http.close(context);
		await host.close(context);
		plugins.close();
		await rm(directory, { recursive: true, force: true });
	}
});
