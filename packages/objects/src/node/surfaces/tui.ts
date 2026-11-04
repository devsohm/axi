import type { Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet, type Host } from "../../host/index.ts";
import { Http } from "../http/index.ts";
import type { Plugins, RolloutStep } from "../plugins/index.ts";
import { buildBase } from "./bundle.ts";
import { scriptsFacet } from "./current.ts";
import { PublishedScripts } from "./published.ts";
import { served } from "./served.ts";
export const TUI_PREFIX = "/_objects/tui/";
export type TuiStart = { readonly base: string; readonly script: string; readonly combined: string };
export type TuiSurfaceOptions = { readonly kind?: string; readonly plugins: Plugins; readonly entry: string };
export type TuiSurface<P extends Principal> = {
	readonly facet: Facet<P>;
	step(name: string): RolloutStep;
	readonly base: string;
};
export async function tuiSurface<P extends Principal>(
	server: Host<P>,
	options: TuiSurfaceOptions,
	context: Context,
): Promise<TuiSurface<P>> {
	const base = await buildBase(options.entry, "sandbox", TUI_PREFIX),
		scripts = new PublishedScripts("tui", options.kind ?? "tui", TUI_PREFIX, base.hash, options.plugins, server);
	await scripts.start(context);
	const facet = defineFacet<P>((host, self) => {
		scriptsFacet<P>("tui", scripts).setup(host, self);
		self.contribute(Http, {
			routes: {
				[`GET ${TUI_PREFIX}start`]: async () => ({
					kind: "json",
					value: { base: base.hash, script: base.script, combined: scripts.set.combined } satisfies TuiStart,
					headers: { "Cache-Control": "no-store" },
				}),
				[`GET ${TUI_PREFIX}base`]: {
					public: true,
					handler: async () => ({ kind: "json", value: base.hash, headers: { "Cache-Control": "no-store" } }),
				},
				[`GET ${TUI_PREFIX}:file`]: async (request) =>
					served(base.files.get(request.path) ?? scripts.file(request.path)),
				[`GET ${TUI_PREFIX}plugin/:file`]: async (request) =>
					served(base.files.get(request.path) ?? scripts.file(request.path)),
			},
		});
	});
	return { facet, base: base.hash, step: (name) => scripts.step(name) };
}
