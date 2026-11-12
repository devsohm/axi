import { awaitWithContext, BACKGROUND_CONTEXT, type Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import type { Host } from "../../host/index.ts";
import type { ScriptSet } from "../../surfaces/index.ts";
import type { HttpResponse } from "../http/index.ts";
import type { BaseInputs, Plugins, RolloutStep } from "../plugins/index.ts";
import { buildBase, type BaseBundle, type BasePlatform, type BaseResolution } from "./bundle.ts";
import { publishTo, type SurfaceName } from "./current.ts";
import { PublishedScripts } from "./published.ts";
import { served } from "./served.ts";

export type SurfaceBuilt =
	| { readonly kind: "built"; readonly base: string; readonly inputs: BaseInputs }
	| { readonly kind: "failed"; readonly error: unknown };
export type SurfaceBuildOptions = {
	readonly kind: string;
	readonly entry: string;
	readonly resolution: BaseResolution;
	readonly plugins: Plugins;
};
type Parts<P extends Principal> = { readonly base: BaseBundle; readonly published: PublishedScripts<P> };
type Result<P extends Principal> = ({ readonly kind: "built" } & Parts<P>) | Extract<SurfaceBuilt, { kind: "failed" }>;
const initialScripts: ScriptSet = { base: "", combined: "", plugins: [] };

export class SurfaceBuild<P extends Principal> {
	readonly #source: {
		readonly surface: SurfaceName;
		readonly platform: BasePlatform;
		readonly prefix: string;
		readonly options: SurfaceBuildOptions;
		readonly server: Host<P>;
	};
	#loading: Promise<Result<P>> | undefined;
	#result: Result<P> | undefined;
	#scripts: PublishedScripts<P> | undefined;
	constructor(
		surface: SurfaceName,
		platform: BasePlatform,
		prefix: string,
		options: SurfaceBuildOptions,
		server: Host<P>,
	) {
		this.#source = { surface, platform, prefix, options, server };
	}
	get set(): ScriptSet {
		return this.#scripts?.set ?? initialScripts;
	}
	get built(): SurfaceBuilt | undefined {
		return this.#result && this.#summary(this.#result);
	}
	async build(): Promise<SurfaceBuilt> {
		return this.#summary(await this.#load());
	}
	async parts(): Promise<Parts<P> | undefined> {
		const result = await this.#load();
		return result.kind === "built" ? result : undefined;
	}
	async file(path: string): Promise<HttpResponse> {
		const parts = await this.parts();
		return parts === undefined
			? { kind: "error", status: 503 }
			: served(parts.base.files.get(path) ?? parts.published.file(path));
	}
	step(name: string): RolloutStep {
		return {
			name,
			kinds: [this.#source.options.kind],
			reload: async (change, context: Context) => {
				const result = await awaitWithContext(this.#load(), context);
				return result.kind === "built"
					? result.published.step(name).reload(change, context)
					: { hosts: [{ host: name, error: result.error }] };
			},
		};
	}
	#summary(result: Result<P>): SurfaceBuilt {
		return result.kind === "failed"
			? { kind: "failed", error: result.error }
			: { kind: "built", base: result.base.hash, inputs: result.base.inputs };
	}
	#load(): Promise<Result<P>> {
		return (this.#loading ??= this.#compile().then((result) => {
			this.#result = result;
			return result;
		}));
	}
	async #compile(): Promise<Result<P>> {
		try {
			const { options, platform, prefix, surface, server } = this.#source;
			const base = await buildBase(options.entry, platform, prefix, options.resolution);
			const published = new PublishedScripts(surface, options.kind, prefix, base.hash, options.plugins, server);
			await published.start(BACKGROUND_CONTEXT);
			this.#scripts = published;
			await publishTo(server, surface, published.set, BACKGROUND_CONTEXT);
			return { kind: "built", base, published };
		} catch (error) {
			return { kind: "failed", error };
		}
	}
}
