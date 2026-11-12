import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { createHost, hostKind, WebScripts } from "../src/index.ts";
import { createHttp } from "../src/node/http/index.ts";
import { createPlugins } from "../src/node/plugins/index.ts";
import { pageScripts, WEB_PREFIX, webSurface } from "../src/node/surfaces/index.ts";

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
