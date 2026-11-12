import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet, type Host } from "../../host/index.ts";
import { REGISTER, type ScriptSet } from "../../surfaces/index.ts";
import { Http, type HttpRequest, type HttpResponse, type HttpRouteOptions } from "../http/index.ts";
import type { Plugins, RolloutStep } from "../plugins/index.ts";
import type { BaseBundle } from "./bundle.ts";
import { scriptsFacet } from "./current.ts";
import { SurfaceBuild, type SurfaceBuilt } from "./surface-build.ts";
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
	readonly conditions?: readonly string[];
} & (WebRoutesOptions | { readonly routes: false });
export type WebRoutesOptions = {
	readonly routes?: true;
	readonly page: (request: HttpRequest, assets: PageAssets) => string | Promise<string>;
	readonly paths?: readonly string[];
	readonly public?: boolean;
};
export type WebSurface<P extends Principal> = {
	readonly facet: Facet<P>;
	step(name: string): RolloutStep;
	readonly built: SurfaceBuilt | undefined;
	build(): Promise<SurfaceBuilt>;
	file(path: string): Promise<HttpResponse>;
	pageAssets(): Promise<PageAssets | undefined>;
	base(): Promise<string | undefined>;
};
export function webSurface<P extends Principal>(
	server: Host<P>,
	options: WebSurfaceOptions,
): WebSurface<P> {
	const building = new SurfaceBuild(
		"web",
		"browser",
		WEB_PREFIX,
		{
			kind: options.kind ?? "web",
			entry: options.entry,
			conditions: options.conditions,
			plugins: options.plugins,
		},
		server,
	);
	const facet = defineFacet<P>((host, self) => {
		scriptsFacet<P>("web", building).setup(host, self);
		if (options.routes === false) return;
		const access = options.public ? { public: true as const } : {};
		const routes: Record<string, HttpRouteOptions> = {};
		for (const suffix of [":file", "plugin/:file", "assets/:file"])
			routes[`GET ${WEB_PREFIX}${suffix}`] = {
				...access,
				handler: async (request) => building.file(request.path),
			};
		routes[`GET ${WEB_PREFIX}base`] = {
			public: true,
			handler: async () => {
				const parts = await building.parts();
				return parts === undefined
					? { kind: "error", status: 503 }
					: { kind: "json", value: parts.base.hash, headers: { "Cache-Control": "no-store" } };
			},
		};
		for (const path of options.paths ?? ["/"])
			routes[`GET ${path}`] = {
				...access,
				page: true,
				handler: async (request) => {
					const parts = await building.parts();
					if (parts === undefined) return { kind: "error", status: 503 };
					const assets = assetsFor(parts.base, parts.published.set);
					return { kind: "html", body: await options.page(request, assets) };
				},
			};
		self.contribute(Http, {
			routes,
			csp: { "style-src": ["'self'"], "img-src": ["'self'", "data:"], "font-src": ["'self'"] },
			scripts: [WEB_PREFIX],
		});
	});
	return {
		facet,
		build: () => building.build(),
		get built() {
			return building.built;
		},
		step: (name) => building.step(name),
		file: (path) => building.file(path),
		async pageAssets() {
			const parts = await building.parts();
			return parts === undefined ? undefined : assetsFor(parts.base, parts.published.set);
		},
		base: async () => (await building.parts())?.base.hash,
	};
}
function assetsFor(base: BaseBundle, set: ScriptSet): PageAssets {
	return {
		bootstrap: pageBootstrap(base.hash, set),
		script: base.script,
		plugins: set.combined,
		styles: [
			...(base.style === undefined ? [] : [base.style]),
			...set.plugins.flatMap((entry) => entry.css === undefined ? [] : [entry.css]),
		],
	};
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
export function pageBootstrap(base: string, set: ScriptSet): string {
	const styles = Object.fromEntries(set.plugins.flatMap(({ name, css }) => css === undefined ? [] : [[name, css]]));
	const data = JSON.stringify({ base, styles, links: {}, queued: [] }).replaceAll("<", "\\u003c");
	return `globalThis.objectsPage=${data};objectsPage.watching=function(event){const link=event.target;if(link&&link.tagName==="LINK")objectsPage.links[link.getAttribute("href")]=event.type};document.addEventListener("load",objectsPage.watching,true);document.addEventListener("error",objectsPage.watching,true);globalThis.${REGISTER}=function(p,d,f){objectsPage.queued.push([p,d,f])};`;
}
