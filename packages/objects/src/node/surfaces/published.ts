import { createHash } from "node:crypto";
import type { Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import type { Host, PluginFailure } from "../../host/index.ts";
import { registeredSource, type ScriptSet } from "../../surfaces/index.ts";
import type { Plugins, PluginScript, RolloutStep } from "../plugins/index.ts";
import { publishTo, type SurfaceName } from "./current.ts";
import { CSS, JAVASCRIPT, mimeOf, type ServedFile } from "./served.ts";
type Published = {
	digest: string;
	text: string;
	css: string | undefined;
	assets: readonly { readonly name: string; readonly bytes: Uint8Array }[];
};
export class PublishedScripts<P extends Principal> {
	readonly #surface: SurfaceName;
	readonly #kind: string;
	readonly #prefix: string;
	readonly #base: string;
	readonly #plugins: Plugins;
	readonly #host: Host<P>;
	readonly #history: Map<string, ServedFile>[] = [];
	#current = new Map<string, Published>();
	#set!: ScriptSet;
	constructor(surface: SurfaceName, kind: string, prefix: string, base: string, plugins: Plugins, host: Host<P>) {
		this.#surface = surface;
		this.#kind = kind;
		this.#prefix = prefix;
		this.#base = base;
		this.#plugins = plugins;
		this.#host = host;
	}
	get set(): ScriptSet {
		return this.#set;
	}
	async start(context: Context): Promise<readonly PluginFailure[]> {
		return this.#publish(await this.#plugins.scripts(this.#kind, context));
	}
	file(path: string): ServedFile | undefined {
		for (let index = this.#history.length - 1; index >= 0; index--) {
			const file = this.#history[index]!.get(path);
			if (file) return file;
		}
		return undefined;
	}
	step(name: string): RolloutStep {
		return {
			name,
			kinds: [this.#kind],
			reload: async (_built, context) => {
				const before = this.#current,
					failed = this.#publish(this.#plugins.current(this.#kind) ?? []);
				await publishTo(this.#host, this.#surface, this.set, context);
				const plugins = { added: [] as string[], changed: [] as string[], removed: [] as string[] };
				for (const [plugin, value] of this.#current) {
					if (!before.has(plugin)) plugins.added.push(plugin);
					else if (before.get(plugin)!.digest !== value.digest) plugins.changed.push(plugin);
				}
				for (const plugin of before.keys()) if (!this.#current.has(plugin)) plugins.removed.push(plugin);
				return { hosts: [{ host: name, report: { plugins, failed, objects: [] } }] };
			},
		};
	}
	#publish(scripts: readonly PluginScript[]): readonly PluginFailure[] {
		const next = new Map<string, Published>(),
			failed: PluginFailure[] = [];
		for (const { plugin, built } of scripts) {
			if (built.kind === "script")
				next.set(plugin.name, {
					digest: built.digest,
					text: registeredSource(plugin.name, built.digest, built.source),
					css: built.css?.text,
					assets: built.assets,
				});
			else {
				failed.push({ plugin: plugin.name, error: new Error(built.errors.join("\n")) });
				const old = this.#current.get(plugin.name);
				if (old) next.set(plugin.name, old);
			}
		}
		this.#current = new Map([...next].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
		const files = new Map<string, ServedFile>(),
			plugins: ScriptSet["plugins"] = [],
			bodies: string[] = [],
			encoder = new TextEncoder();
		for (const [name, item] of this.#current) {
			const stem = `${this.#prefix}plugin/${name.replace("/", "~")}.${item.digest}`;
			files.set(stem + ".js", { mime: JAVASCRIPT, bytes: encoder.encode(item.text) });
			if (item.css !== undefined) files.set(stem + ".css", { mime: CSS, bytes: encoder.encode(item.css) });
			plugins.push({
				name,
				digest: item.digest,
				url: stem + ".js",
				...(item.css === undefined ? {} : { css: stem + ".css" }),
			});
			for (const asset of item.assets)
				files.set(this.#prefix + "assets/" + asset.name, { mime: mimeOf(asset.name), bytes: asset.bytes });
			bodies.push(item.text.replace(/\n\/\/# sourceMappingURL=data:[^\n]*/g, ""));
		}
		const body = bodies.join(""),
			hash = createHash("sha256").update(body).digest("hex").slice(0, 16),
			combined = `${this.#prefix}plugins.${hash}.js`;
		files.set(combined, { mime: JAVASCRIPT, bytes: encoder.encode(body) });
		this.#set = { base: this.#base, combined, plugins };
		this.#history.push(files);
		if (this.#history.length > 4) this.#history.shift();
		return failed;
	}
}
