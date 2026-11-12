export { type BaseBundle, type BasePlatform, type BaseResolution, buildBase, processConditions } from "./bundle.ts";
export type { ServedFile } from "./served.ts";
export type { SurfaceBuilt } from "./surface-build.ts";
export {
	WEB_PREFIX,
	webSurface,
	pageScripts,
	pageBootstrap,
	type PageAssets,
	type WebRoutesOptions,
	type WebSurface,
	type WebSurfaceOptions,
} from "./web.ts";
export { TUI_PREFIX, tuiSurface, type TuiStart, type TuiSurface, type TuiSurfaceOptions } from "./tui.ts";
