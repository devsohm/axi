import type { Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet, type Host } from "../../host/index.ts";
import { REGISTER } from "../../surfaces/index.ts";
import { Http, type HttpRequest, type HttpRouteOptions } from "../http/index.ts";
import type { BaseInputs, Plugins, RolloutStep } from "../plugins/index.ts";
import { buildBase } from "./bundle.ts";
import { scriptsFacet } from "./current.ts";
import { PublishedScripts } from "./published.ts";
import { served } from "./served.ts";
export const WEB_PREFIX = "/_objects/web/";
export type PageAssets = {
	readonly bootstrap: string;
	readonly script: string;
	readonly plugins: string;
	readonly styles: readonly string[];
};
export type WebSurfaceOptions = {
	readonly kind?: string;
	readonly plugins: Plugins;
	readonly entry: string;
	readonly page: (request: HttpRequest, assets: PageAssets) => string | Promise<string>;
	readonly paths?: readonly string[];
	readonly public?: boolean;
	readonly conditions?: readonly string[];
};
export type WebSurface<P extends Principal> = {
	readonly facet: Facet<P>;
	step(name: string): RolloutStep;
	readonly base: string;
	readonly inputs: BaseInputs;
};
export async function webSurface<P extends Principal>(
	server: Host<P>,
	options: WebSurfaceOptions,
	context: Context,
): Promise<WebSurface<P>> {
	const base = await buildBase(options.entry, "browser", WEB_PREFIX, options.conditions),
		scripts = new PublishedScripts("web", options.kind ?? "web", WEB_PREFIX, base.hash, options.plugins, server);
	await scripts.start(context);
	const assets = (): PageAssets => ({
		bootstrap: pageBootstrap(base.hash, scripts.set),
		script: base.script,
		plugins: scripts.set.combined,
		styles: [
			...(base.style === undefined ? [] : [base.style]),
			...scripts.set.plugins.flatMap((entry) => (entry.css === undefined ? [] : [entry.css])),
		],
	});
	const facet = defineFacet<P>((host, self) => {
		scriptsFacet<P>("web", scripts).setup(host, self);
		const access = options.public ? { public: true as const } : {};
		const routes: Record<string, HttpRouteOptions> = {};
		for (const suffix of [":file", "plugin/:file", "assets/:file"])
			routes[`GET ${WEB_PREFIX}${suffix}`] = {
				...access,
				handler: async (request) => served(base.files.get(request.path) ?? scripts.file(request.path)),
			};
		routes[`GET ${WEB_PREFIX}base`] = {
			public: true,
			handler: async () => ({ kind: "json", value: base.hash, headers: { "Cache-Control": "no-store" } }),
		};
		for (const path of options.paths ?? ["/"])
			routes[`GET ${path}`] = {
				...access,
				page: true,
				handler: async (request) => ({ kind: "html", body: await options.page(request, assets()) }),
			};
		self.contribute(Http, {
			routes,
			csp: { "style-src": ["'self'"], "img-src": ["'self'", "data:"], "font-src": ["'self'"] },
			scripts: [WEB_PREFIX],
		});
	});
	return { facet, base: base.hash, inputs: base.inputs, step: (name) => scripts.step(name) };
}
export function pageScripts(assets: PageAssets, nonce: string): string {
	return [
			`<script nonce="${nonce}">${assets.bootstrap}</script>`,
			...assets.styles.map((href) => `<link rel="stylesheet" href="${href}">`),
			`<script defer src="${assets.plugins}"></script>`,
			`<script defer src="${assets.script}"></script>`,
		]
		.join("\n");
}
function pageBootstrap(base: string, set: import("../../surfaces/index.ts").ScriptSet): string {
	const styles = Object.fromEntries(set.plugins.flatMap(({ name, css }) => css === undefined ? [] : [[name, css]]));
	const data = JSON.stringify({ base, styles, links: {}, queued: [] }).replaceAll("<", "\\u003c");
	return `globalThis.objectsPage=${data};objectsPage.watching=function(event){const link=event.target;if(link&&link.tagName==="LINK")objectsPage.links[link.getAttribute("href")]=event.type};document.addEventListener("load",objectsPage.watching,true);document.addEventListener("error",objectsPage.watching,true);globalThis.${REGISTER}=function(p,d,f){objectsPage.queued.push([p,d,f])};`;
}
