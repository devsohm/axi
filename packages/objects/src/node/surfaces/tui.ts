import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet, type Host } from "../../host/index.ts";
import { Http } from "../http/index.ts";
import type { Plugins, RolloutStep } from "../plugins/index.ts";
import { scriptsFacet } from "./current.ts";
import { SurfaceBuild, type SurfaceBuilt } from "./surface-build.ts";
export const TUI_PREFIX = "/_objects/tui/";
export type TuiStart = { readonly base: string; readonly script: string; readonly combined: string };
export type TuiSurfaceOptions = {
	readonly kind?: string;
	readonly plugins: Plugins;
	readonly entry: string;
	readonly conditions?: readonly string[];
	readonly tsconfig?: string;
};
export type TuiSurface<P extends Principal> = {
	readonly facet: Facet<P>;
	step(name: string): RolloutStep;
	readonly built: SurfaceBuilt | undefined;
	build(): Promise<SurfaceBuilt>;
};
export function tuiSurface<P extends Principal>(server: Host<P>, options: TuiSurfaceOptions): TuiSurface<P> {
	const building = new SurfaceBuild(
		"tui",
		"sandbox",
		TUI_PREFIX,
		{
			kind: options.kind ?? "tui",
			entry: options.entry,
			resolution: { conditions: options.conditions, tsconfig: options.tsconfig },
			plugins: options.plugins,
		},
		server,
	);
	const facet = defineFacet<P>((host, self) => {
		scriptsFacet<P>("tui", building).setup(host, self);
		self.contribute(Http, {
			routes: {
				[`GET ${TUI_PREFIX}start`]: async () => {
					const parts = await building.parts();
					if (parts === undefined) return { kind: "error", status: 503 };
					return {
						kind: "json",
						value: {
							base: parts.base.hash,
							script: parts.base.script,
							combined: parts.published.set.combined,
						} satisfies TuiStart,
						headers: { "Cache-Control": "no-store" },
					};
				},
				[`GET ${TUI_PREFIX}base`]: {
					public: true,
					handler: async () => {
						const parts = await building.parts();
						return parts === undefined
							? { kind: "error", status: 503 }
							: { kind: "json", value: parts.base.hash, headers: { "Cache-Control": "no-store" } };
					},
				},
				[`GET ${TUI_PREFIX}:file`]: async (request) => building.file(request.path),
				[`GET ${TUI_PREFIX}plugin/:file`]: async (request) => building.file(request.path),
			},
		});
	});
	return {
		facet,
		build: () => building.build(),
		get built() {
			return building.built;
		},
		step: (name) => building.step(name),
	};
}
